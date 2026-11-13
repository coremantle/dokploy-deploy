import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'

const [certificatePath, keyPath, port = '8443'] = process.argv.slice(2)
const expectedKey = 'smoke-test-key-not-a-secret'

const answers = {
  '/api/project.all': [
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
  '/api/vaultProvider.all': [
    {
      vaultProviderId: 'provider-smoke',
      name: 'infisical-smoke',
      providerType: 'infisical',
      config: { providerType: 'infisical', secretPath: '/smoke/hello' },
    },
  ],
  '/api/vaultProvider.listSecretNames': ['MESSAGE', 'GREETING'],
}

function answer(request, response) {
  const { pathname } = new URL(request.url ?? '/', 'https://localhost')
  const body =
    request.headers['x-api-key'] === expectedKey
      ? answers[pathname]
      : undefined
  const status = request.headers['x-api-key'] === expectedKey ? 200 : 401
  response.writeHead(body === undefined && status === 200 ? 404 : status, {
    'content-type': 'application/json',
  })
  response.end(JSON.stringify(body ?? { message: 'Unauthorized' }))
  console.log(`${request.method} ${pathname} -> ${response.statusCode}`)
}

createServer(
  { cert: readFileSync(certificatePath), key: readFileSync(keyPath) },
  answer,
).listen(Number(port), 'localhost', () => {
  console.log(`fake Dokploy listening on https://localhost:${port}/api`)
})
