import { getInput, setOutput } from '@actions/core'
import Coolify from './coolify.js'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'

interface GitHubEvent {
  pull_request?: {
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
          repository: eventData.pull_request.head.repo.full_name
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

  const { branchOrPR, gitSha, repository } = getGitInfo()

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
    const {
      serviceUUID,
      appUUID,
      appURL,
      supabase_url,
      supabase_service_role_key,
      supabase_anon_key
    } = await coolify.createDeployment({
      ephemeral: ephemeral === 'true',
      checkedOutProjectDir: './',
      deploymentName,
      repository: `https://github.com/${repository}`,
      gitBranch: branchOrPR,
      gitCommitSha: gitSha,
      reset_supabase_db: reset_supabase_db === 'true'
    })
    setOutput('supabase_url', supabase_url)
    setOutput('supabase_service_role_key', supabase_service_role_key)
    setOutput('supabase_anon_key', supabase_anon_key)
    setOutput('app_url', appURL)
    setOutput('service_uuid', serviceUUID)
    setOutput('app_uuid', appUUID)
  }
}
