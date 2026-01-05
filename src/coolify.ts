import { exec } from '@actions/exec'
import { randomBytes } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import JSZip from 'jszip'
import path, { join, relative } from 'path'
import postgres from 'postgres'

import { createClient } from './client/client/client.js'
import { Client } from './client/client/types.js'
import {
  createEnvByApplicationUuid,
  createEnvByServiceUuid,
  createPublicApplication,
  createService,
  deleteApplicationByUuid,
  deleteServiceByUuid,
  deployByTagOrUuid,
  getServiceByUuid,
  listApplications,
  listDeploymentsByAppUuid,
  listEnvsByServiceUuid,
  listServers,
  listServices,
  startApplicationByUuid,
  startServiceByUuid,
  updateApplicationByUuid,
  updateEnvByServiceUuid,
  updateEnvsByServiceUuid,
  updateServiceByUuid
} from './client/sdk.gen.js'
import { TCPTunnelClient } from './tcp-tunnel.js'

/**
 * Checks if an error is a connection timeout error that should be retried
 */
function isConnectionTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    const errorWithCode = error as Error & { code?: string }

    // Check for connection timeout/refused errors
    return (
      errorWithCode.code === 'ECONNREFUSED' ||
      errorWithCode.code === 'ETIMEDOUT' ||
      errorWithCode.code === 'ENOTFOUND' ||
      errorWithCode.code === 'ECONNRESET' ||
      message.includes('connect timeout') ||
      message.includes('connection timeout') ||
      message.includes('fetch failed') ||
      message.includes('networkerror') ||
      message.includes('network error')
    )
  }
  return false
}

/**
 * Creates a fetch wrapper with exponential backoff retry logic for connection timeout errors
 */
function createRetryFetch(
  baseFetch: typeof fetch,
  maxRetries: number = 5,
  initialDelayMs: number = 1000
): typeof fetch {
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    let lastError: unknown
    let delay = initialDelayMs

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await baseFetch(input, init)
      } catch (error) {
        lastError = error

        // Only retry on connection timeout errors
        if (!isConnectionTimeoutError(error)) {
          throw error
        }

        // Don't retry on the last attempt
        if (attempt === maxRetries) {
          break
        }

        console.log(
          `Connection timeout error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`
        )

        // Wait with exponential backoff
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 30000) // Cap at 30 seconds
      }
    }

    // If we've exhausted all retries, throw the last error
    throw lastError
  }
}

export default class Coolify {
  readonly client: Client
  private readonly project_uuid: string
  private readonly environment_uuid: string
  private readonly environment_name: string
  private readonly server_uuid?: string
  private readonly base_deployment_url: string
  private readonly supabase_api_url: string
  private readonly bugsink_dsn: string

  constructor({
    baseUrl,
    token,
    project_uuid,
    environment_uuid,
    environment_name,
    server_uuid,
    supabase_api_url,
    base_deployment_url,
    bugsink_dsn
  }: {
    baseUrl: string
    token: string
    project_uuid: string
    environment_uuid: string
    environment_name: string
    supabase_api_url: string
    server_uuid?: string
    base_deployment_url: string
    bugsink_dsn: string
  }) {
    this.client = createClient({
      baseUrl,
      auth: async () => {
        return token
      },
      fetch: createRetryFetch(globalThis.fetch)
    })
    this.project_uuid = project_uuid
    this.environment_uuid = environment_uuid
    this.environment_name = environment_name
    this.server_uuid = server_uuid
    this.supabase_api_url = supabase_api_url
    this.base_deployment_url = base_deployment_url
    this.bugsink_dsn = bugsink_dsn
  }
  async deployFunctions({
    token,
    serviceUuid,
    folderPath
  }: {
    token: string
    serviceUuid: string
    folderPath: string
  }) {
    const zip = new JSZip()
    // Recursive function to add files to zip
    async function addFolderToZip(
      dirPath: string,
      basePath: string,
      depth: number = 0
    ) {
      const items = await readdir(dirPath)
      for (const item of items) {
        const fullPath = join(dirPath, item)
        const relativePath = relative(basePath, fullPath)
        const itemStat = await stat(fullPath)
        if (itemStat.isDirectory()) {
          await addFolderToZip(fullPath, basePath, depth + 1)
        } else {
          const fileContent = await readFile(fullPath)
          zip.file(relativePath, fileContent)
          if (depth === 1 && item === 'index.ts') {
            console.log(`Deploying ${relativePath}`)
          }
        }
      }
    }
    const functionsFolder = join(folderPath, 'supabase', 'functions')
    // Add all files from the folder to the zip
    await addFolderToZip(functionsFolder, functionsFolder)
    zip.file(
      'config.toml',
      await readFile(join(folderPath, 'supabase', 'config.toml'))
    )
    // Generate the zip file
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const formData = new FormData()
    formData.append('file', new Blob([zipBuffer]), 'functions.zip')
    await fetch(`${this.supabase_api_url}/${serviceUuid}/deploy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    })
  }

  private async waitUntilServiceIsReady({
    serviceUUID,
    timeout_seconds
  }: {
    serviceUUID: string
    timeout_seconds?: number
  }) {
    const client = this.client
    console.log(`Waiting for service ${serviceUUID} to be ready`)

    return new Promise((resolve, reject) => {
      const timeout = timeout_seconds ?? 1200
      const expirationTimeout = setTimeout(() => {
        clearInterval(interval)
        reject(
          new Error(`Timeout waiting for service ${serviceUUID} to be ready`)
        )
      }, timeout * 1000)

      async function checkStatus() {
        const serviceStatus = await getServiceByUuid({
          client,
          path: {
            uuid: serviceUUID
          }
        })
        if (serviceStatus.data && 'status' in serviceStatus.data) {
          if (serviceStatus.data['status'] === 'running:healthy') {
            clearInterval(interval)
            clearTimeout(expirationTimeout)
            resolve(true)
          }
        }
      }

      const interval = setInterval(checkStatus, 5000)
      checkStatus()
    })
  }

  public async checkIfDeploymentUnderway({
    appUUID,
    sha
  }: {
    appUUID: string
    sha: string
  }): Promise<boolean> {
    const client = this.client

    try {
      const deployments = (await listDeploymentsByAppUuid({
        client,
        path: {
          uuid: appUUID
        }
      })) as unknown as {
        data: { deployments: { commit: string; status: string }[] }
      }

      if (!deployments.data) {
        return false
      }

      const deployment = deployments.data?.deployments.find(
        (deployment) =>
          deployment.commit === sha || deployment.commit === 'HEAD'
      )

      if (deployment) {
        // Check if deployment is in progress or finished (not failed, or cancelled)
        const inProgressStatuses = [
          'running',
          'queued',
          'in_progress',
          'finished',
          'pending'
        ]
        return inProgressStatuses.includes(deployment.status)
      }

      return false
    } catch (error) {
      console.warn(`Error checking deployment status: ${error}`)
      return false
    }
  }

  public async waitUntilAppIsReady({
    appUUID,
    sha,
    deployment_uuid,
    timeout_seconds
  }: {
    appUUID: string
    sha?: string
    deployment_uuid?: string
    timeout_seconds?: number
  }) {
    if (!sha && !deployment_uuid) {
      throw new Error('Either sha or deployment_uuid must be provided')
    }
    const client = this.client
    console.log(`Waiting for app ${appUUID} to be ready`)

    return new Promise((resolve, reject) => {
      const timeout = timeout_seconds ?? 600
      const expirationTimeout = setTimeout(() => {
        clearInterval(interval)
        reject(new Error(`Timeout waiting for app ${appUUID} to be ready`))
      }, timeout * 1000)

      async function checkStatus() {
        const deployments = (await listDeploymentsByAppUuid({
          client,
          path: {
            uuid: appUUID
          }
        })) as unknown as {
          data: {
            deployments: {
              commit: string
              status: string
              deployment_uuid: string
            }[]
          }
        }
        if (!deployments.data) {
          console.error(deployments)
          throw new Error(
            `Error getting deployments for app ${appUUID}: ${JSON.stringify(
              deployments
            )}`
          )
        }
        const deployment = deployments.data?.deployments.find(
          (deployment) =>
            (deployment_uuid &&
              deployment.deployment_uuid === deployment_uuid) ||
            (sha && deployment.commit === sha) ||
            deployment.commit === 'HEAD'
        )
        if (deployment) {
          if (deployment.status === 'finished') {
            console.log(`Deployment ${sha} for app ${appUUID} is finished`)
            clearInterval(interval)
            clearTimeout(expirationTimeout)
            resolve(true)
          }
          if (deployment.status === 'failed') {
            throw new Error(
              `Deployment ${deployment_uuid} for app ${appUUID} failed`
            )
          }
        } else {
          console.log(
            'No status found for SHA: ' +
              sha +
              ', deployment_uuid: ' +
              deployment_uuid
          )
          console.log(
            JSON.stringify(
              deployments.data.deployments.map((d) => ({
                commit: d.commit,
                status: d.status
              })),
              null,
              2
            )
          )
        }
      }

      const interval = setInterval(checkStatus, 5000)
      checkStatus()
    })
  }
  private async createOrUpdateEnv({
    serviceUUID,
    env
  }: {
    serviceUUID: string
    env: { key: string; value: string | undefined; isMultiLine?: boolean }
  }) {
    if (!env.value) {
      throw new Error(`Env ${env.key} has no value`)
    }
    const res = await updateEnvByServiceUuid({
      client: this.client,
      path: {
        uuid: serviceUUID
      },
      body: {
        key: env.key,
        value: env.value,
        is_multiline: env.isMultiLine
      }
    })
    if (res.error && res.error.message === 'Environment variable not found.') {
      const res2 = await createEnvByServiceUuid({
        client: this.client,
        path: {
          uuid: serviceUUID
        },
        body: {
          key: env.key,
          value: env.value,
          is_multiline: env.isMultiLine
        }
      })
      if (res2.error) {
        throw new Error(
          `Error creating env ${env.key} for service ${serviceUUID}: ${res2.error.message}`
        )
      }
    }
  }
  private async createEnvsForService({
    serviceUUID,
    envs
  }: {
    serviceUUID: string
    envs: {
      key: string
      value: string | undefined
      isMultiLine?: boolean
      optional?: boolean
    }[]
  }) {
    for (const env of envs) {
      if (!env.value && !env.optional) {
        throw new Error(`Env ${env.key} has no value`)
      }
      if (!env.value && env.optional) {
        continue
      }
      await this.createOrUpdateEnv({
        serviceUUID,
        env
      })
    }
  }

  private async getServerUUID() {
    const servers = await listServers({ client: this.client })
    console.log(servers)
    if (!servers.data || servers.data.length === 0 || !servers.data[0].uuid) {
      throw new Error('No servers found')
    }
    return servers.data[0].uuid
  }
  async updateSecrets({
    serviceUUID,
    postgres_db,
    postgres_password,
    edgeFunctionSecret,
    deployToken,
    supabase_url
  }: {
    serviceUUID: string
    postgres_db: string
    postgres_password: string
    deployToken: string
    edgeFunctionSecret: string
    supabase_url: string
  }) {
    const localPort = 5432
    const tunnel = new TCPTunnelClient(
      `${this.supabase_api_url}/${serviceUUID}/postgres`,
      localPort,
      deployToken
    )
    console.log(`Starting a tunnel to postgres on local port ${localPort}`)
    await tunnel.connect()
    console.log('Tunnel connected')
    const sql = postgres(
      `postgres://postgres:${postgres_password}@localhost:${localPort}/${postgres_db}`
    )
    const existingEdgeFunctionSecret =
      await sql`SELECT id FROM vault.decrypted_secrets where name = 'edge-function-secret'`
    const edgeFunctionSecretUUID =
      existingEdgeFunctionSecret.length > 0
        ? existingEdgeFunctionSecret[0].id
        : null
    if (!edgeFunctionSecretUUID) {
      throw new Error('Edge function secret not found in vault')
    }
    const existingSupabaseProjectURLSecret =
      await sql`SELECT id FROM vault.decrypted_secrets where name = 'supabase_project_url'`
    const supabaseProjectURLSecretUUID =
      existingSupabaseProjectURLSecret.length > 0
        ? existingSupabaseProjectURLSecret[0].id
        : null
    if (!supabaseProjectURLSecretUUID) {
      throw new Error('Supabase project url secret not found in vault')
    }
    await sql`SELECT vault.update_secret(${edgeFunctionSecretUUID}, ${edgeFunctionSecret}, 'edge-function-secret', 'Generated secret for edge functions invoked by postgres')`
    await sql`SELECT vault.update_secret(${supabaseProjectURLSecretUUID}, ${supabase_url}, 'supabase_project_url', 'Generated supabase project url')`
    await sql.end()
    await tunnel.disconnect()
    console.log('Secrets updated')
  }
  private async getSupabaseServiceUUIDOrCreateNewOne({
    supabaseComponentName,
    ephemeral
  }: {
    supabaseComponentName: string
    ephemeral: boolean
  }) {
    const existingServices = await listServices({ client: this.client })
    console.log(
      `Existing services: ${JSON.stringify(
        existingServices.data?.map((service) => service.name)
      )}`
    )
    console.log(`Supabase component name: ${supabaseComponentName}`)
    const existingSupabaseService = existingServices.data?.find(
      (service) => service.name === supabaseComponentName
    )
    let backendServiceUUID: string
    let isNewSupabaseService: boolean = false
    let createdNewSupabaseService: boolean = false
    if (existingSupabaseService && existingSupabaseService.uuid) {
      backendServiceUUID = existingSupabaseService.uuid
      isNewSupabaseService = false
    } else {
      isNewSupabaseService = true
      console.log(`Creating new supabase service ${supabaseComponentName}`)
      createdNewSupabaseService = true
      const updatedDockerCompose = await readFile(
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          '../',
          'supabase-pawtograder.yml'
        ),
        'utf-8'
      )
      //Create backend service
      console.log(`Creating service ${supabaseComponentName}`)
      const backendService = await createService({
        client: this.client,
        body: {
          name: supabaseComponentName,
          description: ephemeral
            ? `Ephemeral Supabase service for ${supabaseComponentName} launched at ${new Date().toISOString()}`
            : undefined,
          project_uuid: this.project_uuid,
          server_uuid: this.server_uuid
            ? this.server_uuid
            : await this.getServerUUID(),
          environment_uuid: this.environment_uuid,
          type: 'supabase',
          environment_name: this.environment_name,
          instant_deploy: false,
          docker_compose_raw:
            Buffer.from(updatedDockerCompose).toString('base64')
        }
      })
      if (!backendService.data?.uuid) {
        console.error(backendService)
        throw new Error('Backend service UUID not found')
      }
      backendServiceUUID = backendService.data.uuid

      console.log(`Updating service ${supabaseComponentName}`)
      const ret = await updateServiceByUuid({
        client: this.client,
        path: {
          uuid: backendServiceUUID
        },
        // @ts-expect-error - They updated the coolify API but not the types :(
        body: {
          name: supabaseComponentName,
          // project_uuid: this.project_uuid,
          // server_uuid: this.server_uuid
          // ? this.server_uuid
          // : await this.getServerUUID(),
          // environment_uuid: this.environment_uuid,
          // environment_name: this.environment_name,
          instant_deploy: false,
          docker_compose_raw:
            Buffer.from(updatedDockerCompose).toString('base64')
        }
      })
      console.log(`Update service response: ${JSON.stringify(ret)}`)

      // Generate a random 64-character deployment key
      const deploymentKey = randomBytes(32).toString('hex')
      //Set the functions deployment key
      await this.createOrUpdateEnv({
        serviceUUID: backendServiceUUID,
        env: {
          key: 'SERVICE_SUPABASE_FUNCTIONS_DEPLOYMENT_KEY',
          value: deploymentKey
        }
      })
      // Generate a random 64-character edge function secret
      const edgeFunctionSecret = randomBytes(32).toString('hex')

      await this.createEnvsForService({
        serviceUUID: backendServiceUUID,
        envs: [
          {
            key: 'GITHUB_APP_ID',
            value: process.env.GITHUB_APP_ID
          },
          {
            key: 'GITHUB_OAUTH_CLIENT_ID',
            value: process.env.GITHUB_OAUTH_CLIENT_ID
          },
          {
            key: 'GITHUB_OAUTH_CLIENT_SECRET',
            value: process.env.GITHUB_OAUTH_CLIENT_SECRET
          },
          {
            key: 'GITHUB_PRIVATE_KEY_STRING',
            value: process.env.GITHUB_PRIVATE_KEY_STRING?.replace(/\\n/g, '\n'),
            isMultiLine: true
          },
          {
            key: 'AWS_ACCESS_KEY_ID',
            value: process.env.AWS_ACCESS_KEY_ID
          },
          {
            key: 'AWS_SECRET_ACCESS_KEY',
            value: process.env.AWS_SECRET_ACCESS_KEY
          },
          {
            key: 'EDGE_FUNCTION_SECRET',
            value: edgeFunctionSecret
          },
          {
            key: 'PGRST_DB_SCHEMAS',
            value: 'public,graphql_public,pgmq_public'
          },
          {
            key: 'SENTRY_DSN',
            value: process.env.SENTRY_DSN,
            optional: true
          },
          {
            key: 'UPSTASH_REDIS_REST_URL',
            value: process.env.UPSTASH_REDIS_REST_URL,
            optional: true
          },
          {
            key: 'UPSTASH_REDIS_REST_TOKEN',
            value: process.env.UPSTASH_REDIS_REST_TOKEN,
            optional: true
          }
        ]
      })

      await updateEnvsByServiceUuid({
        client: this.client,
        path: {
          uuid: backendServiceUUID
        },
        body: {
          data: [
            {
              key: 'ENABLE_EMAIL_AUTOCONFIRM',
              value: 'true'
            },
            {
              key: 'ENABLE_PHONE_SIGNUP',
              value: 'false'
            }
          ]
        }
      })
    }
    const serviceEnvs = await listEnvsByServiceUuid({
      client: this.client,
      path: {
        uuid: backendServiceUUID
      }
    })
    function getServiceEnvOrThrow(key: string) {
      const env = serviceEnvs.data?.find((env) => env.key === key)
      if (!env || !env.value) {
        throw new Error(`Environment variable ${key} not found`)
      }
      return env.value
    }

    const postgres_db = getServiceEnvOrThrow('POSTGRES_DB')
    const postgres_hostname = getServiceEnvOrThrow('POSTGRES_HOSTNAME')
    const postgres_port = getServiceEnvOrThrow('POSTGRES_PORT')
    const postgres_password = getServiceEnvOrThrow('SERVICE_PASSWORD_POSTGRES')
    const supabase_url = getServiceEnvOrThrow(
      'SERVICE_URL_SUPABASEKONG'
    ).replace(':8000', '')
    const supabase_anon_key = getServiceEnvOrThrow('SERVICE_SUPABASEANON_KEY')
    const supabase_service_role_key = getServiceEnvOrThrow(
      'SERVICE_SUPABASESERVICE_KEY'
    )
    const deploymentKey = getServiceEnvOrThrow(
      'SERVICE_SUPABASE_FUNCTIONS_DEPLOYMENT_KEY'
    )
    const edgeFunctionSecret = getServiceEnvOrThrow('EDGE_FUNCTION_SECRET')
    const studio_user = getServiceEnvOrThrow('SERVICE_USER_ADMIN')
    const studio_password = getServiceEnvOrThrow('SERVICE_PASSWORD_ADMIN')
    console.log(`SERVICE_URL_SUPABASEKONG: ${supabase_url}`)
    await this.createOrUpdateEnv({
      serviceUUID: backendServiceUUID,
      env: {
        key: 'SERVICE_URL_SUPABASEKONG',
        value: supabase_url
      }
    })

    if (createdNewSupabaseService) {
      await startServiceByUuid({
        client: this.client,
        path: {
          uuid: backendServiceUUID
        }
      })
    }
    return {
      backendServiceUUID,
      postgres_db,
      postgres_hostname,
      postgres_port,
      postgres_password,
      supabase_url,
      supabase_anon_key,
      supabase_service_role_key,
      deploymentKey,
      isNewSupabaseService,
      edgeFunctionSecret,
      studio_user,
      studio_password
    }
  }
  async cleanup({
    cleanup_service_uuid,
    cleanup_app_uuid
  }: {
    cleanup_service_uuid: string
    cleanup_app_uuid: string
  }) {
    const existingServices = await listServices({ client: this.client })
    const existingSupabaseService = existingServices.data?.find(
      (service) => service.uuid === cleanup_service_uuid
    )
    if (existingSupabaseService && existingSupabaseService.uuid) {
      await deleteServiceByUuid({
        client: this.client,
        path: {
          uuid: existingSupabaseService.uuid
        }
      })
    } else {
      console.log(`Supabase service ${cleanup_service_uuid} not found`)
    }
    const existingApplications = await listApplications({
      client: this.client
    })
    const frontendApp = existingApplications.data?.find(
      (app) => app.uuid === cleanup_app_uuid
    )
    if (frontendApp && frontendApp.uuid) {
      await deleteApplicationByUuid({
        client: this.client,
        path: {
          uuid: frontendApp.uuid
        }
      })
    } else {
      console.log(`Frontend app ${cleanup_app_uuid} not found`)
    }
  }

  async cleanupByName({ deploymentName }: { deploymentName: string }) {
    const frontendAppName = `${deploymentName}-frontend`
    const supabaseServiceName = `${deploymentName}-supabase`

    console.log(
      `Looking for deployments to cleanup: ${frontendAppName}, ${supabaseServiceName}`
    )

    // Find and delete supabase service
    const existingServices = await listServices({ client: this.client })
    const supabaseService = existingServices.data?.find(
      (service) => service.name === supabaseServiceName
    )
    if (supabaseService && supabaseService.uuid) {
      console.log(`Deleting supabase service: ${supabaseService.uuid}`)
      await deleteServiceByUuid({
        client: this.client,
        path: {
          uuid: supabaseService.uuid
        }
      })
      console.log(`Deleted supabase service: ${supabaseServiceName}`)
    } else {
      console.log(`Supabase service ${supabaseServiceName} not found`)
    }

    // Find and delete frontend app
    const existingApplications = await listApplications({
      client: this.client
    })
    const frontendApp = existingApplications.data?.find(
      (app) => app.name === frontendAppName
    )
    if (frontendApp && frontendApp.uuid) {
      console.log(`Deleting frontend app: ${frontendApp.uuid}`)
      await deleteApplicationByUuid({
        client: this.client,
        path: {
          uuid: frontendApp.uuid
        }
      })
      console.log(`Deleted frontend app: ${frontendAppName}`)
    } else {
      console.log(`Frontend app ${frontendAppName} not found`)
    }

    return {
      deletedService: supabaseService?.uuid,
      deletedApp: frontendApp?.uuid
    }
  }

  async createDeployment({
    ephemeral,
    checkedOutProjectDir,
    deploymentName,
    repository,
    gitBranch,
    gitCommitSha,
    reset_supabase_db
  }: {
    ephemeral: boolean
    checkedOutProjectDir: string
    deploymentName: string
    repository: string
    gitBranch: string
    gitCommitSha: string
    reset_supabase_db?: boolean
  }) {
    const supabaseComponentName = `${deploymentName}-supabase`
    const {
      backendServiceUUID,
      postgres_db,
      postgres_hostname,
      postgres_port,
      postgres_password,
      supabase_url,
      supabase_anon_key,
      supabase_service_role_key,
      deploymentKey,
      isNewSupabaseService,
      edgeFunctionSecret,
      studio_user,
      studio_password
    } = await this.getSupabaseServiceUUIDOrCreateNewOne({
      supabaseComponentName,
      ephemeral
    })
    console.log(`Backend service UUID: ${backendServiceUUID}`)

    const frontendAppName = `${deploymentName}-frontend`
    //If there is already a frontend app with the target name, delete it
    const existingApplications = await listApplications({
      client: this.client
    })

    console.log('Waiting for backend to start')
    await this.waitUntilServiceIsReady({
      serviceUUID: backendServiceUUID
    })
    console.log('Backend started')

    await this.deployFunctions({
      token: deploymentKey,
      serviceUuid: backendServiceUUID,
      folderPath: checkedOutProjectDir
    })

    await this.pushMigrations({
      serviceUUID: backendServiceUUID,
      deployToken: deploymentKey,
      checkedOutProjectDir,
      resetDb: isNewSupabaseService || reset_supabase_db,
      postgresPassword: postgres_password,
      supabase_url: supabase_url,
      edgeFunctionSecret: edgeFunctionSecret
    })
    if (isNewSupabaseService) {
      //Update vault secrets
      await this.updateSecrets({
        serviceUUID: backendServiceUUID,
        deployToken: deploymentKey,
        postgres_db,
        postgres_password,
        edgeFunctionSecret,
        supabase_url
      })
    }

    const existingFrontendApp = existingApplications.data?.find(
      (app) => app.name === frontendAppName
    )
    let appUUID = existingFrontendApp?.uuid
    let appURL = `https://${deploymentName}.${this.base_deployment_url}`
    const isNewDeployment = !existingFrontendApp || !appUUID

    // For existing deployments, retrieve the actual URL from Coolify
    if (!isNewDeployment && existingFrontendApp?.fqdn) {
      // fqdn may contain multiple domains separated by commas, take the first one
      const domains = existingFrontendApp.fqdn.split(',').map((d) => d.trim())
      if (domains.length > 0 && domains[0]) {
        appURL = domains[0]
        console.log(`Using existing app URL from Coolify: ${appURL}`)
      }
    }

    if (isNewDeployment) {
      //Create frontend service, deploy it
      const frontendApp = await createPublicApplication({
        client: this.client,
        body: {
          name: frontendAppName,
          project_uuid: this.project_uuid,
          environment_uuid: this.environment_uuid,
          description: ephemeral
            ? `Ephemeral frontend app for ${deploymentName} launched at ${new Date().toISOString()}`
            : undefined,
          build_pack: 'nixpacks',
          environment_name: this.environment_name,
          server_uuid: this.server_uuid
            ? this.server_uuid
            : await this.getServerUUID(),
          git_repository: repository,
          git_branch: gitBranch,
          git_commit_sha: gitCommitSha,
          ports_exposes: '3000',
          domains: `https://${deploymentName}.${this.base_deployment_url}`
        }
      })
      appUUID = frontendApp.data?.uuid
      if (frontendApp.error) {
        console.error(frontendApp)
        throw new Error('Frontend app creation failed')
      }
      if (!appUUID) {
        throw new Error('Frontend app UUID not found')
      }
      console.log(`Frontend app UUID: ${appUUID}`)

      const client = this.client
      async function createEnvForApp(
        appUUID: string,
        envs: { key: string; value: string }[]
      ) {
        for (const env of envs) {
          await createEnvByApplicationUuid({
            client,
            path: {
              uuid: appUUID
            },
            body: {
              key: env.key,
              value: env.value
            }
          })
        }
      }

      await createEnvForApp(appUUID, [
        { key: 'POSTGRES_DB', value: postgres_db },
        { key: 'POSTGRES_HOSTNAME', value: postgres_hostname },
        { key: 'POSTGRES_PORT', value: postgres_port },
        { key: 'POSTGRES_PASSWORD', value: postgres_password },
        { key: 'SUPABASE_SERVICE_ROLE_KEY', value: supabase_service_role_key },
        { key: 'NEXT_PUBLIC_SUPABASE_URL', value: supabase_url },
        { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', value: supabase_anon_key },
        {
          key: 'NEXT_PUBLIC_BUGSINK_DSN',
          value: this.bugsink_dsn
        },
        {
          key: 'NEXT_PUBLIC_BUGSINK_HOST',
          value: extractHostFromDsn(this.bugsink_dsn)
        },
        {
          key: 'VERCEL_GIT_COMMIT_SHA',
          value: '$SOURCE_COMMIT'
        }
      ])

      //Deploy the frontend
      const { data: startData } = await startApplicationByUuid({
        client,
        path: {
          uuid: appUUID
        }
      })
      const deployment_uuid = startData?.deployment_uuid
      //Wait for frontend to start
      console.log('Waiting for frontend to start')
      await this.waitUntilAppIsReady({
        appUUID: appUUID,
        deployment_uuid: deployment_uuid,
        timeout_seconds: 20 * 60 //20 minutes, woof
      })
      console.log('Frontend started')
    } else {
      // appUUID is guaranteed to be defined here since isNewDeployment is false
      if (!appUUID) {
        throw new Error('Frontend app UUID not found for existing deployment')
      }
      //Update the commit SHA of the frontend app
      await updateApplicationByUuid({
        client: this.client,
        path: {
          uuid: appUUID
        },
        body: {
          git_commit_sha: gitCommitSha
        }
      })
      console.log(
        `Deploying frontend app ${appUUID} with commit ${gitCommitSha}`
      )
      const { data: deploymentsData } = await deployByTagOrUuid({
        client: this.client,
        query: {
          uuid: appUUID
        }
      })
      if (
        !deploymentsData ||
        !deploymentsData.deployments ||
        deploymentsData.deployments.length === 0
      ) {
        throw new Error('Failed to deploy frontend app')
      }
      const { deployment_uuid } = deploymentsData.deployments[0]
      if (!deployment_uuid) {
        throw new Error('Failed to deploy frontend app')
      }
      console.log(`Waiting for deployment ${deployment_uuid} to finish`)

      await this.waitUntilAppIsReady({
        appUUID: appUUID,
        deployment_uuid: deployment_uuid,
        timeout_seconds: 20 * 60 //20 minutes, woof
      })
    }

    return {
      serviceUUID: backendServiceUUID,
      appUUID,
      appURL,
      supabase_url,
      supabase_service_role_key,
      supabase_anon_key,
      postgres_db,
      postgres_hostname,
      postgres_port,
      postgres_password,
      studio_user,
      studio_password,
      isNewDeployment
    }
  }

  async pushMigrations({
    serviceUUID,
    deployToken,
    checkedOutProjectDir,
    postgresPassword,
    resetDb,
    supabase_url,
    edgeFunctionSecret
  }: {
    serviceUUID: string
    deployToken: string
    checkedOutProjectDir: string
    postgresPassword: string
    resetDb?: boolean
    supabase_url: string
    edgeFunctionSecret: string
  }) {
    const localPort = 5432
    const tunnel = new TCPTunnelClient(
      `${this.supabase_api_url}/${serviceUUID}/postgres`,
      localPort,
      deployToken
    )
    console.log(`Starting a tunnel to postgres on local port ${localPort}`)
    await tunnel.connect()
    console.log('Tunnel connected')
    let command = ''
    if (!resetDb)
      command = `./node_modules/.bin/supabase db push --include-all --db-url postgres://postgres:${postgresPassword}@localhost:${localPort}/postgres`
    else {
      const sql = postgres(
        `postgres://postgres:${postgresPassword}@localhost:${localPort}/postgres`
      )
      await sql`TRUNCATE TABLE storage.buckets CASCADE`
      await sql`TRUNCATE TABLE storage.objects CASCADE`
      await sql`TRUNCATE TABLE vault.secrets CASCADE`
      await sql.end()
      command = `./node_modules/.bin/supabase db reset --db-url postgres://postgres:${postgresPassword}@localhost:${localPort}/postgres`
    }
    await exec(command, undefined, {
      cwd: checkedOutProjectDir,
      input: Buffer.from('y'),
      env: {
        PGSSLMODE: 'disable'
      }
    })
    console.log('Migrations pushed')
    tunnel.disconnect()
    if (resetDb) {
      //Need to re-set the vault secrets that get overwritten with dev defaults
      await this.updateSecrets({
        serviceUUID: serviceUUID,
        deployToken: deployToken,
        postgres_db: 'postgres',
        postgres_password: postgresPassword,
        edgeFunctionSecret: edgeFunctionSecret,
        supabase_url: supabase_url
      })
    }
  }
}
function extractHostFromDsn(bugsink_dsn: string): string {
  const url = new URL(bugsink_dsn)
  return url.protocol + '//' + url.hostname
}
