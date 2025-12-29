import { getInput, setOutput } from '@actions/core'
import Coolify from './coolify.js'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'

interface GitHubEvent {
  action?: string // 'opened', 'synchronize', 'closed', etc.
  pull_request?: {
    number: number
    html_url: string
    title: string
    merged: boolean
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
  prAction?: string
  prMerged?: boolean
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
          prTitle: eventData.pull_request.title,
          prAction: eventData.action,
          prMerged: eventData.pull_request.merged
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

async function postPRComment({
  githubToken,
  baseRepository,
  prNumber,
  appURL,
  gitSha,
  supabaseUrl
}: {
  githubToken: string
  baseRepository: string
  prNumber: number
  appURL: string
  gitSha: string
  supabaseUrl: string
}) {
  const commentMarker = '<!-- pawtograder-deployment-comment -->'
  const commentBody = `${commentMarker}
## 🚀 Deployment Ready!

| Status | Details |
|--------|---------|
| **App URL** | [${appURL}](${appURL}) |
| **Supabase URL** | ${supabaseUrl} |
| **Commit** | \`${gitSha.substring(0, 7)}\` |
| **Deployed at** | ${new Date().toISOString()} |

---
*This comment is automatically updated on each deployment.*`

  const apiUrl = `https://api.github.com/repos/${baseRepository}/issues/${prNumber}/comments`

  // First, try to find an existing comment to update
  const listResponse = await fetch(apiUrl, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json'
    }
  })

  if (listResponse.ok) {
    const comments = (await listResponse.json()) as Array<{
      id: number
      body: string
    }>
    const existingComment = comments.find((c) => c.body.includes(commentMarker))

    if (existingComment) {
      // Update existing comment
      const updateResponse = await fetch(
        `https://api.github.com/repos/${baseRepository}/issues/comments/${existingComment.id}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `token ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body: commentBody })
        }
      )

      if (updateResponse.ok) {
        console.log('Updated existing PR comment')
        return
      }
    }
  }

  // Create new comment
  const createResponse = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ body: commentBody })
  })

  if (createResponse.ok) {
    console.log('Posted new PR comment')
  } else {
    console.error(
      `Failed to post PR comment: ${createResponse.status} ${createResponse.statusText}`
    )
  }
}

async function updatePRCommentForCleanup({
  githubToken,
  baseRepository,
  prNumber,
  merged
}: {
  githubToken: string
  baseRepository: string
  prNumber: number
  merged: boolean
}) {
  const commentMarker = '<!-- pawtograder-deployment-comment -->'
  const status = merged ? '✅ Merged' : '❌ Closed'
  const commentBody = `${commentMarker}
## 🧹 Deployment Cleaned Up

| Status | Details |
|--------|---------|
| **PR Status** | ${status} |
| **Cleaned up at** | ${new Date().toISOString()} |

---
*The deployment resources have been automatically cleaned up.*`

  const apiUrl = `https://api.github.com/repos/${baseRepository}/issues/${prNumber}/comments`

  // Try to find existing comment to update
  const listResponse = await fetch(apiUrl, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json'
    }
  })

  if (listResponse.ok) {
    const comments = (await listResponse.json()) as Array<{
      id: number
      body: string
    }>
    const existingComment = comments.find((c) => c.body.includes(commentMarker))

    if (existingComment) {
      const updateResponse = await fetch(
        `https://api.github.com/repos/${baseRepository}/issues/comments/${existingComment.id}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `token ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body: commentBody })
        }
      )

      if (updateResponse.ok) {
        console.log('Updated PR comment to show cleanup status')
      }
    }
  }
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
    ? `PR #${prNumber}: ${prTitle}\n${prUrl}`
    : `Branch: ${branchOrPR}\nhttps://github.com/${repository}/tree/${branchOrPR}`

  const studioUrl = `https://${deployment.studio_user}:${deployment.studio_password}@${deployment.supabase_url.replace('https://', '')}`

  // Plain message with code block for easy copy/paste
  const message = `🚀 **New Deployment Ready!**

📍 **Source:** ${githubLink}

🌐 **App URL:** ${deployment.appURL}

🔧 **Supabase Studio:** ${studioUrl}

📋 **Environment Variables** (copy/paste ready):
\`\`\`bash
# Database
POSTGRES_DB=${deployment.postgres_db}
POSTGRES_HOSTNAME=${deployment.postgres_hostname}
POSTGRES_PORT=${deployment.postgres_port}
POSTGRES_PASSWORD=${deployment.postgres_password}

# Supabase
SUPABASE_URL=${deployment.supabase_url}
SUPABASE_ANON_KEY=${deployment.supabase_anon_key}
SUPABASE_SERVICE_ROLE_KEY=${deployment.supabase_service_role_key}
NEXT_PUBLIC_SUPABASE_URL=${deployment.supabase_url}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${deployment.supabase_anon_key}

# Studio
STUDIO_USER=${deployment.studio_user}
STUDIO_PASSWORD=${deployment.studio_password}
STUDIO_URL=${deployment.supabase_url}

# App
NEXT_PUBLIC_PAWTOGRADER_URL=${deployment.appURL}
NEXT_PUBLIC_PAWTOGRADER_WEB_URL=${deployment.appURL}
\`\`\`

🔑 Commit: \`${gitSha.substring(0, 7)}\` | 🏷️ Service: \`${deployment.serviceUUID}\``

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content: message
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error(
      `Failed to send Discord webhook: ${response.status} ${response.statusText}`
    )
    console.error(`Discord error response: ${errorBody}`)
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
  const github_token = getInput('github_token')

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

  const {
    branchOrPR,
    gitSha,
    repository,
    prNumber,
    prUrl,
    prTitle,
    prAction,
    prMerged
  } = getGitInfo()

  const deploymentName =
    ephemeral.toLowerCase() === 'true'
      ? `${branchOrPR.replace('/', '-')}-${randomUUID()}`
      : branchOrPR.replace('/', '-')

  // Auto-cleanup when PR is closed (only for non-ephemeral deployments)
  if (prAction === 'closed' && ephemeral.toLowerCase() !== 'true') {
    console.log(
      `PR #${prNumber} was ${prMerged ? 'merged' : 'closed'}. Cleaning up deployment: ${deploymentName}`
    )
    const { deletedService, deletedApp } = await coolify.cleanupByName({
      deploymentName
    })
    setOutput('cleanup_performed', 'true')
    setOutput('deleted_service_uuid', deletedService || '')
    setOutput('deleted_app_uuid', deletedApp || '')

    // Update PR comment to show deployment was cleaned up
    const baseRepository = process.env.GITHUB_REPOSITORY
    if (github_token && prNumber && baseRepository) {
      await updatePRCommentForCleanup({
        githubToken: github_token,
        baseRepository,
        prNumber,
        merged: prMerged || false
      })
    }
    return
  }

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

    // Post PR comment if this is a PR and we have a GitHub token
    const baseRepository = process.env.GITHUB_REPOSITORY
    if (github_token && prNumber && baseRepository) {
      await postPRComment({
        githubToken: github_token,
        baseRepository,
        prNumber,
        appURL: deployment.appURL,
        gitSha,
        supabaseUrl: deployment.supabase_url
      })
    }
  }
}
