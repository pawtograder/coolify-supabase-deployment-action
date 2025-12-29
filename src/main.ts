import { getInput, setOutput } from '@actions/core'
import Coolify from './coolify.js'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'

interface GitHubEvent {
  pull_request?: {
    number: number
    html_url: string
    title: string
    head: {
      ref: string
      sha: string
      repo: {
        full_name: string
      }
    }
  }
}

interface GitInfo {
  branchOrPR: string
  gitSha: string
  repository: string
  prNumber?: number
  prUrl?: string
  prTitle?: string
}

function getGitInfo(): GitInfo {
  const eventPath = process.env.GITHUB_EVENT_PATH
  const eventName = process.env.GITHUB_EVENT_NAME
  const defaultRepository = process.env.GITHUB_REPOSITORY

  // For pull_request_target, we need to get the PR head ref/sha/repo from the event payload
  if (
    eventPath &&
    (eventName === 'pull_request_target' || eventName === 'pull_request')
  ) {
    try {
      const eventData: GitHubEvent = JSON.parse(readFileSync(eventPath, 'utf8'))
      if (eventData.pull_request) {
        return {
          branchOrPR: eventData.pull_request.head.ref,
          gitSha: eventData.pull_request.head.sha,
          // Use the PR head repo (important for fork PRs)
          repository: eventData.pull_request.head.repo.full_name,
          prNumber: eventData.pull_request.number,
          prUrl: eventData.pull_request.html_url,
          prTitle: eventData.pull_request.title
        }
      }
    } catch {
      // Fall through to default behavior
    }
  }

  // Default: use environment variables (works for push events, etc.)
  const branchOrPR = process.env.GITHUB_REF_NAME
  const gitSha = process.env.GITHUB_SHA
  if (!branchOrPR || !gitSha || !defaultRepository) {
    throw new Error('Unable to determine git ref, SHA, and repository')
  }
  return { branchOrPR, gitSha, repository: defaultRepository }
}

interface DeploymentInfo {
  appURL: string
  supabase_url: string
  supabase_anon_key: string
  supabase_service_role_key: string
  postgres_db: string
  postgres_hostname: string
  postgres_port: string
  postgres_password: string
  studio_user: string
  studio_password: string
  serviceUUID: string
  appUUID: string
}

async function sendDiscordWebhook({
  webhookUrl,
  gitInfo,
  deployment,
  repository
}: {
  webhookUrl: string
  gitInfo: GitInfo
  deployment: DeploymentInfo
  repository: string
}) {
  const { branchOrPR, gitSha, prNumber, prUrl, prTitle } = gitInfo

  // Build GitHub link - either PR or branch
  const githubLink = prUrl
    ? `[PR #${prNumber}: ${prTitle}](${prUrl})`
    : `[Branch: ${branchOrPR}](https://github.com/${repository}/tree/${branchOrPR})`

  const studioUrl = `https://${deployment.studio_user}:${deployment.studio_password}@${deployment.supabase_url.replace('https://', '')}`

  const embed = {
    title: '🚀 New Deployment Ready!',
    color: 0x00ff00, // Green
    fields: [
      {
        name: '📍 Source',
        value: githubLink,
        inline: false
      },
      {
        name: '🌐 App URL',
        value: `[${deployment.appURL}](${deployment.appURL})`,
        inline: false
      },
      {
        name: '🔧 Supabase Studio',
        value: `[Open Studio](${studioUrl})`,
        inline: false
      },
      {
        name: '📊 Environment Variables',
        value: [
          '```',
          `POSTGRES_DB=${deployment.postgres_db}`,
          `POSTGRES_HOSTNAME=${deployment.postgres_hostname}`,
          `POSTGRES_PORT=${deployment.postgres_port}`,
          `POSTGRES_PASSWORD=${deployment.postgres_password}`,
          `SUPABASE_URL=${deployment.supabase_url}`,
          `SUPABASE_ANON_KEY=${deployment.supabase_anon_key}`,
          `SUPABASE_SERVICE_ROLE_KEY=${deployment.supabase_service_role_key}`,
          `NEXT_PUBLIC_SUPABASE_URL=${deployment.supabase_url}`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY=${deployment.supabase_anon_key}`,
          `STUDIO_USER=${deployment.studio_user}`,
          `STUDIO_PASSWORD=${deployment.studio_password}`,
          `STUDIO_URL=${deployment.supabase_url}`,
          `NEXT_PUBLIC_PAWTOGRADER_URL=${deployment.appURL}`,
          `NEXT_PUBLIC_PAWTOGRADER_WEB_URL=${deployment.appURL}`,
          '```'
        ].join('\n'),
        inline: false
      },
      {
        name: '🔑 Commit SHA',
        value: `\`${gitSha.substring(0, 7)}\``,
        inline: true
      },
      {
        name: '🏷️ Service UUID',
        value: `\`${deployment.serviceUUID}\``,
        inline: true
      }
    ],
    timestamp: new Date().toISOString()
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      embeds: [embed]
    })
  })

  if (!response.ok) {
    console.error(
      `Failed to send Discord webhook: ${response.status} ${response.statusText}`
    )
  } else {
    console.log('Discord webhook sent successfully')
  }
}

export async function run() {
  const coolify_api_url = getInput('coolify_api_url')
  const coolify_api_token = getInput('coolify_api_token')
  const coolify_project_uuid = getInput('coolify_project_uuid')
  const coolify_environment_uuid = getInput('coolify_environment_uuid')
  const coolify_environment_name = getInput('coolify_environment_name')
  const coolify_server_uuid = getInput('coolify_server_uuid')
  const coolify_supabase_api_url = getInput('coolify_supabase_api_url')
  const ephemeral = getInput('ephemeral')
  const base_deployment_url = getInput('base_deployment_url')
  const cleanup_service_uuid = getInput('cleanup_service_uuid')
  const cleanup_app_uuid = getInput('cleanup_app_uuid')
  const reset_supabase_db = getInput('reset_supabase_db')
  const bugsink_dsn = getInput('bugsink_dsn')
  const discord_webhook_url = getInput('discord_webhook_url')

  const coolify = new Coolify({
    baseUrl: coolify_api_url,
    token: coolify_api_token,
    project_uuid: coolify_project_uuid,
    environment_uuid: coolify_environment_uuid,
    environment_name: coolify_environment_name,
    server_uuid: coolify_server_uuid,
    supabase_api_url: coolify_supabase_api_url,
    base_deployment_url,
    bugsink_dsn
  })

  const { branchOrPR, gitSha, repository, prNumber, prUrl, prTitle } =
    getGitInfo()

  const deploymentName =
    ephemeral.toLowerCase() === 'true'
      ? `${branchOrPR.replace('/', '-')}-${randomUUID()}`
      : branchOrPR.replace('/', '-')

  if (cleanup_service_uuid || cleanup_app_uuid) {
    await coolify.cleanup({
      cleanup_service_uuid,
      cleanup_app_uuid
    })
  } else {
    const deployment = await coolify.createDeployment({
      ephemeral: ephemeral === 'true',
      checkedOutProjectDir: './',
      deploymentName,
      repository: `https://github.com/${repository}`,
      gitBranch: branchOrPR,
      gitCommitSha: gitSha,
      reset_supabase_db: reset_supabase_db === 'true'
    })

    setOutput('supabase_url', deployment.supabase_url)
    setOutput('supabase_service_role_key', deployment.supabase_service_role_key)
    setOutput('supabase_anon_key', deployment.supabase_anon_key)
    setOutput('app_url', deployment.appURL)
    setOutput('service_uuid', deployment.serviceUUID)
    setOutput('app_uuid', deployment.appUUID)

    // Send Discord webhook notification if configured
    if (discord_webhook_url) {
      await sendDiscordWebhook({
        webhookUrl: discord_webhook_url,
        gitInfo: { branchOrPR, gitSha, repository, prNumber, prUrl, prTitle },
        deployment,
        repository
      })
    }
  }
}
