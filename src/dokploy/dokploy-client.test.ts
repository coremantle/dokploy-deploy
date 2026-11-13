import { describe, effect, expect } from '@effect/vitest'
import { Context, Effect, Fiber, Layer, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from 'effect/http'
import type { HttpClientRequest } from 'effect/http'

import { ActionInputs } from '#action-inputs.config.ts'
import {
  DokployClient,
  DokployRequestError,
  DokployResponseError,
  DokployUnauthorizedError,
} from '#dokploy/dokploy-client.ts'

const apiKey = 'test-member-api-key'

interface SeenRequest {
  readonly url: URL
  readonly apiKey: string | undefined
}

interface FakeAnswer {
  readonly status: number
  readonly body: string
}

function jsonAnswer(body: unknown, status = 200): FakeAnswer {
  return { status, body: JSON.stringify(body) }
}

function answerFor({
  request,
  answer,
}: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly answer: FakeAnswer
}) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(answer.body, {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function fakeDokploy(answer: FakeAnswer) {
  const seen: Array<SeenRequest> = []
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      seen.push({ url, apiKey: request.headers['x-api-key'] })
      return answerFor({ request, answer })
    }),
  )
  const layer = DokployClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        ActionInputs.buildTestLayer({
          apiUrl: new URL('https://dokploy.example.com/api/'),
          apiKey: Redacted.make(apiKey),
        }),
      ),
    ),
  )
  return { seen, layer }
}

function unreachableDokploy() {
  const httpClient = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: 'getaddrinfo ENOTFOUND dokploy.example.com',
        }),
      }),
    ),
  )
  return DokployClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        ActionInputs.testLayer,
      ),
    ),
  )
}

const demoProjects = [
  {
    projectId: 'project-demo',
    name: 'Demo',
    description: null,
    projectTags: [],
    environments: [
      {
        environmentId: 'environment-production',
        name: 'production',
        isDefault: true,
        applications: [],
        compose: [
          { composeId: 'compose-hello', name: 'hello', composeStatus: 'done' },
        ],
      },
    ],
  },
]

describe('DokployClient', () => {
  effect('should list the projects with the api key header', () =>
    Effect.gen(function* () {
      // Given: Dokploy answering project.all
      const { seen, layer } = fakeDokploy(jsonAnswer(demoProjects))

      // When: listing the projects
      const projects = yield* DokployClient.pipe(
        Effect.flatMap(({ projects }) => projects),
        Effect.provide(layer),
      )

      // Then: the call carries the key and only the fields the action reads are kept
      expect(seen[0]?.url.href).toBe(
        'https://dokploy.example.com/api/project.all',
      )
      expect(seen[0]?.apiKey).toBe(apiKey)
      expect(projects).toEqual([
        {
          projectId: 'project-demo',
          name: 'Demo',
          environments: [
            {
              environmentId: 'environment-production',
              name: 'production',
              compose: [{ composeId: 'compose-hello', name: 'hello' }],
            },
          ],
        },
      ])
    }),
  )

  effect('should keep only the name, type and path of a vault provider', () =>
    Effect.gen(function* () {
      // Given: a provider as vaultProvider.all returns it, secret masked
      const { layer } = fakeDokploy(
        jsonAnswer([
          {
            vaultProviderId: 'provider-demo',
            name: 'infisical-demo',
            providerType: 'infisical',
            organizationId: 'organization',
            assignments: [{ projectId: 'project-demo', environmentIds: [] }],
            config: {
              providerType: 'infisical',
              siteUrl: 'https://infisical.example.com',
              clientId: 'client-id',
              clientSecret: '********',
              projectId: 'infisical-project',
              environmentSlug: 'prod',
              secretPath: '/demo/hello',
            },
          },
        ]),
      )

      // When: listing the providers
      const providers = yield* DokployClient.pipe(
        Effect.flatMap(({ vaultProviders }) => vaultProviders),
        Effect.provide(layer),
      )

      // Then: nothing else of the config is kept in memory
      expect(providers).toEqual([
        {
          vaultProviderId: 'provider-demo',
          name: 'infisical-demo',
          providerType: 'infisical',
          config: { secretPath: '/demo/hello' },
        },
      ])
    }),
  )

  effect('should list the secret names of a provider for the target', () =>
    Effect.gen(function* () {
      // Given: Dokploy answering listSecretNames
      const { seen, layer } = fakeDokploy(
        jsonAnswer(['MESSAGE', 'DEMO_IMPORTED']),
      )

      // When: listing the secret names
      const names = yield* DokployClient.pipe(
        Effect.flatMap((client) =>
          client.listSecretNames({
            vaultProviderId: 'provider-demo',
            projectId: 'project-demo',
            environmentId: 'environment-production',
          }),
        ),
        Effect.provide(layer),
      )

      // Then: the provider, project and environment are passed as query parameters
      expect(names).toEqual(['MESSAGE', 'DEMO_IMPORTED'])
      expect(seen[0]?.url.pathname).toBe('/api/vaultProvider.listSecretNames')
      expect(Object.fromEntries(seen[0]?.url.searchParams ?? [])).toEqual({
        vaultProviderId: 'provider-demo',
        projectId: 'project-demo',
        environmentId: 'environment-production',
      })
    }),
  )

  effect('should tell a member without access from a rejected key', () =>
    Effect.gen(function* () {
      // Given: Dokploy refusing a service the member cannot see
      const { layer } = fakeDokploy(
        jsonAnswer(
          {
            message: "You don't have access to this project",
            code: 'UNAUTHORIZED',
          },
          401,
        ),
      )

      // When: listing the secret names
      const error = yield* Effect.flip(
        DokployClient.pipe(
          Effect.flatMap((client) =>
            client.listSecretNames({
              vaultProviderId: 'provider-demo',
              projectId: 'project-other',
              environmentId: 'environment-production',
            }),
          ),
          Effect.provide(layer),
        ),
      )

      // Then: the error says the key lacks access, with Dokploy's own words
      expect(error).toBeInstanceOf(DokployUnauthorizedError)
      expect(error).toMatchObject({ reason: 'no-access' })
      expect(error.message).toContain("You don't have access to this project")
    }),
  )

  effect(
    'should point at the rate limit when Dokploy answers a bare Unauthorized',
    () =>
      Effect.gen(function* () {
        // Given: Dokploy rejecting the key itself, as it does past the rate limit
        const { layer } = fakeDokploy(
          jsonAnswer({ message: 'Unauthorized' }, 401),
        )

        // When: listing the projects
        const error = yield* Effect.flip(
          DokployClient.pipe(
            Effect.flatMap(({ projects }) => projects),
            Effect.provide(layer),
          ),
        )

        // Then: the error names the likely causes, never the key
        expect(error).toMatchObject({
          reason: 'key-rejected',
          endpoint: 'project.all',
        })
        expect(error.message).toContain('rateLimitEnabled: false')
        expect(error.message).not.toContain(apiKey)
      }),
  )

  effect('should report the status and the message of any other refusal', () =>
    Effect.gen(function* () {
      // Given: a provider not assigned to the environment
      const { layer } = fakeDokploy(
        jsonAnswer(
          {
            message:
              'This vault provider is not enabled for the given project/environment',
          },
          403,
        ),
      )

      // When: listing the secret names
      const error = yield* Effect.flip(
        DokployClient.pipe(
          Effect.flatMap((client) =>
            client.listSecretNames({
              vaultProviderId: 'provider-demo',
              projectId: 'project-demo',
              environmentId: 'environment-staging',
            }),
          ),
          Effect.provide(layer),
        ),
      )

      // Then: the endpoint, status and Dokploy's message are all in the error
      expect(error).toEqual(
        new DokployRequestError({
          endpoint: 'vaultProvider.listSecretNames',
          status: 403,
          message:
            'Dokploy answered 403 on vaultProvider.listSecretNames: This vault provider is not enabled for the given project/environment',
        }),
      )
    }),
  )

  effect('should report a failure whose body is not JSON by its status', () =>
    Effect.gen(function* () {
      // Given: a proxy answering an HTML error page
      const { layer } = fakeDokploy({
        status: 502,
        body: '<html>Bad gateway</html>',
      })

      // When: listing the projects
      const error = yield* Effect.flip(
        DokployClient.pipe(
          Effect.flatMap(({ projects }) => projects),
          Effect.provide(layer),
        ),
      )

      // Then: the status is reported, the page is not
      expect(error.message).toBe('Dokploy answered 502 on project.all')
    }),
  )

  effect('should refuse an answer that is not the expected shape', () =>
    Effect.gen(function* () {
      // Given: an api-url pointing at something that answers other JSON
      const { layer } = fakeDokploy(jsonAnswer({ projects: [] }))

      // When: listing the projects
      const error = yield* Effect.flip(
        DokployClient.pipe(
          Effect.flatMap(({ projects }) => projects),
          Effect.provide(layer),
        ),
      )

      // Then: the action fails instead of acting on a guess
      expect(error).toBeInstanceOf(DokployResponseError)
    }),
  )

  effect('should fail clearly when Dokploy cannot be reached', () =>
    Effect.gen(function* () {
      // Given: a host that does not resolve
      const layer = unreachableDokploy()

      // When: listing the projects
      const error = yield* Effect.flip(
        DokployClient.pipe(
          Effect.flatMap(({ projects }) => projects),
          Effect.provide(layer),
        ),
      )

      // Then: the error names the endpoint and the transport failure
      expect(error).toBeInstanceOf(DokployRequestError)
      expect(error.message).toContain('could not be reached on project.all')
    }),
  )
  effect('should never let fetch follow a redirect with the key', () =>
    Effect.gen(function* () {
      // Given: a transport that records the fetch options of the request
      const redirects: Array<string | undefined> = []
      const httpClient = HttpClient.make((request) =>
        Effect.withFiberSucceed((fiber) => {
          redirects.push(
            Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)
              ?.redirect,
          )
          return answerFor({ request, answer: jsonAnswer(demoProjects) })
        }),
      )
      const layer = DokployClient.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, httpClient),
            ActionInputs.testLayer,
          ),
        ),
      )

      // When: listing the projects
      yield* DokployClient.pipe(
        Effect.flatMap(({ projects }) => projects),
        Effect.provide(layer),
      )

      // Then: fetch is told to hand redirects back instead of following them
      expect(redirects).toEqual(['manual'])
    }),
  )

  effect('should fail on a redirect instead of following it', () =>
    Effect.gen(function* () {
      // Given: a proxy redirecting the API to plain http
      const { layer } = fakeDokploy({ status: 301, body: '' })

      // When: listing the projects
      const error = yield* Effect.flip(
        DokployClient.pipe(
          Effect.flatMap(({ projects }) => projects),
          Effect.provide(layer),
        ),
      )

      // Then: the redirect fails the call
      expect(error.message).toBe('Dokploy answered 301 on project.all')
    }),
  )

  effect('should give up on a Dokploy that never answers', () =>
    Effect.gen(function* () {
      // Given: a Dokploy accepting the connection but never answering
      const httpClient = HttpClient.make(() => Effect.never)
      const layer = DokployClient.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, httpClient),
            ActionInputs.testLayer,
          ),
        ),
      )
      const fiber = yield* DokployClient.pipe(
        Effect.flatMap(({ projects }) => projects),
        Effect.provide(layer),
        Effect.flip,
        Effect.forkChild,
      )

      // When: thirty seconds go by
      yield* TestClock.adjust('30 seconds')
      const error = yield* Fiber.join(fiber)

      // Then: the call fails naming the endpoint
      expect(error).toEqual(DokployRequestError.timedOut('project.all'))
    }),
  )

  effect('should accept a provider without a secret path', () =>
    Effect.gen(function* () {
      // Given: a provider of another type, whose config has a null path
      const { layer } = fakeDokploy(
        jsonAnswer([
          {
            vaultProviderId: 'provider-vault',
            name: 'vault',
            providerType: 'hashicorp',
            config: { providerType: 'hashicorp', secretPath: null },
          },
        ]),
      )

      // When: listing the providers
      const providers = yield* DokployClient.pipe(
        Effect.flatMap(({ vaultProviders }) => vaultProviders),
        Effect.provide(layer),
      )

      // Then: the unrelated provider does not fail the plan
      expect(providers).toHaveLength(1)
    }),
  )
})

interface SeenWrite {
  readonly method: string
  readonly url: URL
  readonly apiKey: string | undefined
  readonly body: unknown
}

function recordingDokploy(answer: FakeAnswer) {
  const seen: Array<SeenWrite> = []
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      seen.push({
        url,
        method: request.method,
        apiKey: request.headers['x-api-key'],
        body:
          request.body instanceof HttpBody.Uint8Array
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      })
      return answerFor({ request, answer })
    }),
  )
  const layer = DokployClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        ActionInputs.buildTestLayer({ apiKey: Redacted.make(apiKey) }),
      ),
    ),
  )
  return { seen, layer }
}

describe('DokployClient reads and writes of a compose', () => {
  effect('should read the env of a compose, empty when Dokploy has none', () =>
    Effect.gen(function* () {
      // Given: compose.one answering a compose without env
      const { seen, layer } = recordingDokploy(
        jsonAnswer({ composeId: 'compose-hello', name: 'hello', env: null }),
      )

      // When: reading its env
      const env = yield* DokployClient.pipe(
        Effect.flatMap((client) => client.composeEnv('compose-hello')),
        Effect.provide(layer),
      )

      // Then: an empty block, read with the compose id
      expect(env).toBe('')
      expect(seen[0]?.url.pathname).toBe('/api/compose.one')
      expect(seen[0]?.url.searchParams.get('composeId')).toBe('compose-hello')
    }),
  )

  effect('should keep only the routing fields of a domain', () =>
    Effect.gen(function* () {
      // Given: domain.byComposeId answering a full domain
      const { layer } = recordingDokploy(
        jsonAnswer([
          {
            domainId: 'domain-web',
            host: 'app.demo.example.com',
            https: true,
            port: 3000,
            path: '/',
            serviceName: 'web',
            domainType: 'compose',
            certificateType: 'letsencrypt',
            composeId: 'compose-hello',
            middlewares: [],
            stripPath: false,
          },
        ]),
      )

      // When: listing the domains
      const domains = yield* DokployClient.pipe(
        Effect.flatMap((client) => client.composeDomains('compose-hello')),
        Effect.provide(layer),
      )

      // Then: the fields the diff compares are kept
      expect(domains).toEqual([
        {
          domainId: 'domain-web',
          host: 'app.demo.example.com',
          https: true,
          port: 3000,
          path: '/',
          serviceName: 'web',
          certificateType: 'letsencrypt',
        },
      ])
    }),
  )

  effect('should post the env block with the api key', () =>
    Effect.gen(function* () {
      // Given: Dokploy accepting the write
      const { seen, layer } = recordingDokploy(jsonAnswer(true))

      // When: saving the env
      yield* DokployClient.pipe(
        Effect.flatMap((client) =>
          client.saveEnvironment({ composeId: 'compose-hello', env: 'A=1\n' }),
        ),
        Effect.provide(layer),
      )

      // Then: a JSON POST to compose.saveEnvironment
      expect(seen).toEqual([
        {
          apiKey,
          method: 'POST',
          url: new URL(
            'https://dokploy.example.com/api/compose.saveEnvironment',
          ),
          body: { composeId: 'compose-hello', env: 'A=1\n' },
        },
      ])
    }),
  )

  effect('should create, update and delete compose domains', () =>
    Effect.gen(function* () {
      // Given: Dokploy accepting every write
      const { seen, layer } = recordingDokploy(jsonAnswer({}))
      const settings = {
        host: 'app.demo.example.com',
        path: '/',
        port: 3000,
        serviceName: 'web',
        https: true,
        certificateType: 'letsencrypt',
      }

      // When: creating, updating and deleting
      yield* DokployClient.pipe(
        Effect.flatMap((client) =>
          Effect.all([
            client.createDomain({ composeId: 'compose-hello', ...settings }),
            client.updateDomain({ domainId: 'domain-web', ...settings }),
            client.deleteDomain('domain-old'),
          ]),
        ),
        Effect.provide(layer),
      )

      // Then: each write targets its endpoint as a compose domain
      expect(seen.map(({ url, body }) => [url.pathname, body])).toEqual([
        [
          '/api/domain.create',
          { composeId: 'compose-hello', ...settings, domainType: 'compose' },
        ],
        [
          '/api/domain.update',
          { domainId: 'domain-web', ...settings, domainType: 'compose' },
        ],
        ['/api/domain.delete', { domainId: 'domain-old' }],
      ])
    }),
  )

  effect('should fail a refused write with the endpoint and the message', () =>
    Effect.gen(function* () {
      // Given: a member whose role cannot write env vars
      const { layer } = recordingDokploy(
        jsonAnswer({ message: 'Permission denied: envVars write' }, 403),
      )

      // When: saving the env
      const error = yield* Effect.flip(
        DokployClient.pipe(
          Effect.flatMap((client) =>
            client.saveEnvironment({ composeId: 'compose-hello', env: '' }),
          ),
          Effect.provide(layer),
        ),
      )

      // Then: the error names the endpoint, the status and Dokploy's words
      expect(error.message).toBe(
        'Dokploy answered 403 on compose.saveEnvironment: Permission denied: envVars write',
      )
    }),
  )
})
