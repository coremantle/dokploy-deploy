import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'

const [
  certificatePath,
  keyPath,
  port = '8443',
  commit = '0123456789abcdef0123456789abcdef01234567',
] = process.argv.slice(2)
const expectedKey = 'smoke-test-key-not-a-secret'

const compose = {
  env: 'MESSAGE=typed-by-hand\nLEGACY=1\n',
  domains: [
    {
      domainId: 'domain-legacy',
      host: 'legacy.smoke.example.com',
      path: '/',
      port: 8080,
      serviceName: 'hello',
      https: true,
      certificateType: 'letsencrypt',
      domainType: 'compose',
    },
  ],
}

let nextDomain = 1

const deployments = []

// Why: like Dokploy, the deployment ends `done` first and records its commit a moment later — the action must wait for it.
function runDeployment() {
  const now = new Date().toISOString()
  const deployment = {
    deploymentId: `deployment-${deployments.length + 1}`,
    title: 'Manual deployment',
    description: '',
    status: 'running',
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    errorMessage: null,
  }
  deployments.unshift(deployment)
  setTimeout(() => {
    deployment.status = 'done'
    deployment.finishedAt = new Date().toISOString()
    setTimeout(() => {
      deployment.title = 'smoke commit'
      deployment.description = `Commit: ${commit}`
    }, 1000)
  }, 1000)
  return { success: true, message: 'Deployment queued' }
}

const reads = {
  '/api/project.all': () => [
    {
      projectId: 'project-smoke',
      name: 'Smoke',
      environments: [
        {
          environmentId: 'environment-production',
          name: 'production',
          compose: [{ composeId: 'compose-hello', name: 'hello' }],
        },
      ],
    },
  ],
  '/api/vaultProvider.all': () => [
    {
      vaultProviderId: 'provider-smoke',
      name: 'infisical-smoke',
      providerType: 'infisical',
      config: { providerType: 'infisical', secretPath: '/smoke/hello' },
    },
  ],
  '/api/vaultProvider.listSecretNames': () => ['MESSAGE', 'GREETING'],
  '/api/compose.one': () => ({
    composeId: 'compose-hello',
    name: 'hello',
    env: compose.env,
  }),
  '/api/domain.byComposeId': () => compose.domains,
  '/api/deployment.allByCompose': () => deployments,
  '/api/deployment.readLogs': () => 'Docker Compose Deployed: ✅\n',
}

const writes = {
  '/api/compose.saveEnvironment': ({ env }) => {
    compose.env = env
    return true
  },
  '/api/domain.create': (domain) => {
    const created = { ...domain, domainId: `domain-${nextDomain++}` }
    compose.domains.push(created)
    return created
  },
  '/api/domain.update': (domain) => {
    compose.domains = compose.domains.map((current) =>
      current.domainId === domain.domainId ? { ...current, ...domain } : current,
    )
    return true
  },
  '/api/compose.deploy': () => runDeployment(),
  '/api/domain.delete': ({ domainId }) => {
    compose.domains = compose.domains.filter(
      (current) => current.domainId !== domainId,
    )
    return true
  },
}

function reply({ response, status, body }) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function answer({ request, response, rawBody }) {
  const { pathname } = new URL(request.url ?? '/', 'https://localhost')
  const handlers = request.method === 'POST' ? writes : reads
  const handler = handlers[pathname]
  if (request.headers['x-api-key'] !== expectedKey) {
    reply({ response, status: 401, body: { message: 'Unauthorized' } })
  } else if (handler === undefined) {
    reply({ response, status: 404, body: { message: 'Not found' } })
  } else {
    reply({
      response,
      status: 200,
      body: handler(rawBody === '' ? {} : JSON.parse(rawBody)),
    })
  }
  console.log(`${request.method} ${pathname} -> ${response.statusCode}`)
}

createServer(
  { cert: readFileSync(certificatePath), key: readFileSync(keyPath) },
  (request, response) => {
    let rawBody = ''
    request.on('data', (chunk) => {
      rawBody += chunk
    })
    request.on('end', () => answer({ request, response, rawBody }))
  },
).listen(Number(port), 'localhost', () => {
  console.log(`fake Dokploy listening on https://localhost:${port}/api`)
})
