import { getInput, setOutput } from '@actions/core'
import Coolify from './coolify.js'
import { randomUUID } from 'crypto'

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
  const branchOrPR = process.env.GITHUB_REF_NAME
  const repositoryName = process.env.GITHUB_REPOSITORY
  if (!branchOrPR || !repositoryName || !process.env.GITHUB_SHA) {
    throw new Error('GITHUB_REF_NAME and GITHUB_REPOSITORY must be set')
  }

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
      repository: repositoryName,
      gitBranch: branchOrPR,
      gitCommitSha: process.env.GITHUB_SHA,
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
