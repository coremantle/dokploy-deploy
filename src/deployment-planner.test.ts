import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'

import { ActionInputs, testCommit } from '#action-inputs.config.ts'
import type { ComposeFile } from '#compose/compose-file.ts'
import {
  DeploymentPlanner,
  OpenBaoSecretStateError,
  UnknownEnvironmentError,
} from '#deployment-planner.ts'
import type {
  DokployDomain,
  DokployProject,
  SecretNamesQuery,
  VaultProvider,
} from '#dokploy/dokploy-client.ts'
import { DokployClient } from '#dokploy/dokploy-client.ts'
import { VaultProviderError } from '#dokploy/dokploy-target.ts'
import {
  MissingComposeVariablesError,
  NoSecretKeysError,
  ReferenceGuardError,
  VersionKeyCollisionError,
  VersionWithoutCommitError,
} from '#env/env-references.ts'
import {
  MissingSecretReferencesError,
  MountGuardError,
  VersionKeyMappedError,
} from '#env/openbao-references.ts'
import { PlainValueCollisionError } from '#env/plain-values.ts'
import type { Manifest, ManifestEnvironment } from '#manifest/manifest.ts'
import type { SecretState } from '#openbao/openbao-metadata.ts'
import { OpenBaoMetadata } from '#openbao/openbao-metadata.ts'
import { WorkspaceFiles } from '#workspace-files.ts'

const demoManifest: Manifest = {
  version: 1,
  composeFile: 'docker-compose.dokploy.yml',
  secrets: { folder: '/demo/hello' },
  environments: {
    production: {
      dokploy: { project: 'Demo', environment: 'production', compose: 'hello' },
      domain: 'demo.example.com',
    },
  },
  domains: [
    {
      service: 'hello',
      subdomain: 'hello',
      port: 8080,
      path: '/',
      https: true,
      certificateType: 'letsencrypt',
    },
  ],
}

const demoCompose: ComposeFile = {
  services: ['hello'],
  requiredVariables: ['MESSAGE'],
  routerHosts: [],
}

const demoProjects: ReadonlyArray<DokployProject> = [
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
]

const demoProvider: VaultProvider = {
  vaultProviderId: 'provider-demo',
  name: 'infisical-demo',
  providerType: 'infisical',
  config: { secretPath: '/demo/hello' },
}

interface FakeWorld {
  readonly manifest?: Manifest
  readonly compose?: ComposeFile
  readonly keys?: ReadonlyArray<string>
  readonly environment?: string
  readonly currentEnv?: string
  readonly currentDomains?: ReadonlyArray<DokployDomain>
  readonly versionEnv?: Option.Option<string>
  readonly commit?: Option.Option<string>
}

function plannerIn({
  manifest = demoManifest,
  compose = demoCompose,
  keys = ['MESSAGE', 'DEMO_IMPORTED', 'DEMO_MESSAGE'],
  environment = 'production',
  currentEnv = '',
  currentDomains = [],
  versionEnv = Option.none(),
  commit = Option.some(testCommit),
}: FakeWorld) {
  const dokployCalls: Array<string> = []
  const queries: Array<SecretNamesQuery> = []
  const layer = DeploymentPlanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionInputs.buildTestLayer({ environment, versionEnv, commit }),
        OpenBaoMetadata.testLayer,
        WorkspaceFiles.buildTestLayer({
          readManifest: () => Effect.succeed(manifest),
          readCompose: () => Effect.succeed(compose),
        }),
        DokployClient.buildTestLayer({
          projects: Effect.sync(() => {
            dokployCalls.push('project.all')
            return demoProjects
          }),
          vaultProviders: Effect.sync(() => {
            dokployCalls.push('vaultProvider.all')
            return [demoProvider]
          }),
          listSecretNames: (query) =>
            Effect.sync(() => {
              dokployCalls.push('vaultProvider.listSecretNames')
              queries.push(query)
              return keys
            }),
          composeEnv: (composeId) =>
            Effect.sync(() => {
              dokployCalls.push(`compose.one ${composeId}`)
              return currentEnv
            }),
          composeDomains: (composeId) =>
            Effect.sync(() => {
              dokployCalls.push(`domain.byComposeId ${composeId}`)
              return currentDomains
            }),
        }),
      ),
    ),
  )
  return { layer, dokployCalls, queries }
}

function planWith(layer: Layer.Layer<DeploymentPlanner>) {
  return DeploymentPlanner.pipe(
    Effect.flatMap(({ plan }) => plan),
    Effect.provide(layer),
    Effect.withSpan('DeploymentPlannerTest.plan'),
  )
}

describe('DeploymentPlanner', () => {
  effect('should plan the references and domains of the environment', () =>
    Effect.gen(function* () {
      // Given: the Demo canary, its folder and its provider
      const { layer, queries } = plannerIn({})

      // When: planning
      const plan = yield* planWith(layer)

      // Then: the block references every key through babel's default provider
      expect(plan.secrets).toEqual({
        kind: 'infisical',
        provider: 'infisical-demo',
        folder: '/demo/hello',
      })
      expect(plan.env).toBe(
        [
          "DEMO_IMPORTED='${{vault.infisical-demo./demo/hello:DEMO_IMPORTED}}'",
          "DEMO_MESSAGE='${{vault.infisical-demo./demo/hello:DEMO_MESSAGE}}'",
          "MESSAGE='${{vault.infisical-demo./demo/hello:MESSAGE}}'",
          '',
        ].join('\n'),
      )
      expect(plan.dokploy.composeId).toBe('compose-hello')
      expect(plan.domains.map(({ host }) => host)).toEqual([
        'hello.demo.example.com',
      ])
      expect(queries).toEqual([
        {
          vaultProviderId: 'provider-demo',
          projectId: 'project-demo',
          environmentId: 'environment-production',
        },
      ])
    }),
  )

  effect('should diff the plan against the compose in Dokploy', () =>
    Effect.gen(function* () {
      // Given: Dokploy holding a hand-typed env and a domain the manifest dropped
      const { layer, dokployCalls } = plannerIn({
        keys: ['MESSAGE'],
        currentEnv: 'MESSAGE=literal-value\nOLD=1\n',
        currentDomains: [
          {
            domainId: 'domain-old',
            host: 'old.demo.example.com',
            path: '/',
            port: 8080,
            serviceName: 'hello',
            https: true,
            certificateType: 'letsencrypt',
          },
        ],
      })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: the changes name keys and routes, read from the resolved compose
      expect(plan.changes.env).toEqual({
        drift: true,
        added: [],
        changed: ['MESSAGE'],
        removed: ['OLD'],
      })
      expect(plan.changes.domains.create.map(({ host }) => host)).toEqual([
        'hello.demo.example.com',
      ])
      expect(
        plan.changes.domains.delete.map(({ domainId }) => domainId),
      ).toEqual(['domain-old'])
      expect(dokployCalls).toContain('compose.one compose-hello')
      expect(dokployCalls).toContain('domain.byComposeId compose-hello')
      expect(plan.unsupported).toEqual([])
      expect(plan.strayRouterHosts).toEqual([])
    }),
  )

  effect('should find no change once Dokploy holds the plan', () =>
    Effect.gen(function* () {
      // Given: a first plan, and Dokploy holding exactly what it would write
      const first = yield* planWith(plannerIn({ keys: ['MESSAGE'] }).layer)
      const { layer } = plannerIn({
        keys: ['MESSAGE'],
        currentEnv: first.env,
        currentDomains: first.domains.map((domain, index) => ({
          ...domain,
          domainId: `domain-${index}`,
        })),
      })

      // When: planning again
      const plan = yield* planWith(layer)

      // Then: nothing would be written
      expect(plan.changes.env.drift).toBe(false)
      expect(plan.changes.domains.create).toEqual([])
      expect(plan.changes.domains.update).toEqual([])
      expect(plan.changes.domains.delete).toEqual([])
    }),
  )

  effect('should report the routes that set allowedMethods', () =>
    Effect.gen(function* () {
      // Given: a domain restricting its methods
      const manifest: Manifest = {
        ...demoManifest,
        domains: [{ ...demoManifest.domains[0], allowedMethods: ['GET'] }],
      }
      const { layer } = plannerIn({ manifest })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: the route is reported as unsupported
      expect(plan.unsupported).toEqual(['hello.demo.example.com/'])
    }),
  )

  effect('should report the router hosts the manifest does not declare', () =>
    Effect.gen(function* () {
      // Given: allow-list routers, one on the manifest's host, one on a renamed host
      const compose: ComposeFile = {
        ...demoCompose,
        routerHosts: [
          {
            service: 'hello',
            router: 'hello-methods-web',
            host: 'hello.demo.example.com',
          },
          {
            service: 'hello',
            router: 'hello-methods-websecure',
            host: 'hi.demo.example.com',
          },
        ],
      }
      const { layer } = plannerIn({ compose })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: only the renamed host is reported, and the plan still succeeds
      expect(plan.strayRouterHosts).toEqual([
        {
          service: 'hello',
          router: 'hello-methods-websecure',
          host: 'hi.demo.example.com',
        },
      ])
    }),
  )

  effect('should not report a router host of another environment', () =>
    Effect.gen(function* () {
      // Given: a router on the staging host, planned for production
      const manifest: Manifest = {
        ...demoManifest,
        environments: {
          ...demoManifest.environments,
          staging: {
            dokploy: {
              project: 'Demo',
              environment: 'staging',
              compose: 'hello',
            },
            domain: 'staging.example.com',
          },
        },
      }
      const compose: ComposeFile = {
        ...demoCompose,
        routerHosts: [
          {
            service: 'hello',
            router: 'hello-methods-web',
            host: 'hello.staging.example.com',
          },
        ],
      }
      const { layer } = plannerIn({ manifest, compose })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: it is not reported
      expect(plan.strayRouterHosts).toEqual([])
    }),
  )

  effect('should plan the same thing when run a second time', () =>
    Effect.gen(function* () {
      // Given: the same inputs and a provider listing keys in another order
      const first = plannerIn({ keys: ['MESSAGE', 'DEMO_MESSAGE'] })
      const second = plannerIn({ keys: ['DEMO_MESSAGE', 'MESSAGE'] })

      // When: planning twice
      const plans = yield* Effect.all([
        planWith(first.layer),
        planWith(second.layer),
      ])

      // Then: both plans are identical, so a re-run reports no change
      expect(plans[0]).toEqual(plans[1])
    }),
  )

  effect('should use the provider the manifest names', () =>
    Effect.gen(function* () {
      // Given: a manifest naming the provider explicitly
      const manifest: Manifest = {
        ...demoManifest,
        environments: {
          production: {
            dokploy: {
              project: 'Demo',
              environment: 'production',
              compose: 'hello',
            },
            domain: 'demo.example.com',
            secrets: { provider: 'infisical-demo' },
          },
        },
      }
      const { layer } = plannerIn({ manifest })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: that provider is used
      expect(plan.secrets).toEqual({
        kind: 'infisical',
        provider: 'infisical-demo',
        folder: '/demo/hello',
      })
    }),
  )

  effect(
    'should refuse a folder outside the project before calling Dokploy',
    () =>
      Effect.gen(function* () {
        // Given: a manifest pointing at another application's folder
        const manifest = { ...demoManifest, secrets: { folder: '/octant' } }
        const { layer, dokployCalls } = plannerIn({ manifest })

        // When: planning
        const error = yield* Effect.flip(planWith(layer))

        // Then: the guard fails the plan and Dokploy is never called
        expect(error).toEqual(
          ReferenceGuardError.outside({ folder: '/octant', project: 'Demo' }),
        )
        expect(dokployCalls).toEqual([])
      }),
  )

  effect('should fail when the compose file needs a key the folder lacks', () =>
    Effect.gen(function* () {
      // Given: a compose file requiring a variable the folder does not hold
      const compose = {
        ...demoCompose,
        requiredVariables: ['MESSAGE', 'SMTP_URL'],
      }
      const { layer } = plannerIn({ compose })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the plan fails before anything could be written
      expect(error).toEqual(
        MissingComposeVariablesError.forVariables({
          compose: 'docker-compose.dokploy.yml',
          variables: ['SMTP_URL'],
        }),
      )
    }),
  )

  effect('should fail on an environment the manifest does not declare', () =>
    Effect.gen(function* () {
      // Given: the staging environment requested from a production-only manifest
      const { layer, dokployCalls } = plannerIn({ environment: 'staging' })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the declared environments are listed and Dokploy is not called
      expect(error).toEqual(
        UnknownEnvironmentError.notDeclared({
          environment: 'staging',
          declared: ['production'],
        }),
      )
      expect(dokployCalls).toEqual([])
    }),
  )
  effect('should report an empty folder rather than missing compose keys', () =>
    Effect.gen(function* () {
      // Given: a provider that lists no key while the compose file needs one
      const { layer } = plannerIn({ keys: [] })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the error points at the provider, not at the secrets
      expect(error).toEqual(
        NoSecretKeysError.forFolder({
          provider: 'infisical-demo',
          folder: '/demo/hello',
        }),
      )
    }),
  )

  effect('should append the deployed commit when version-env is set', () =>
    Effect.gen(function* () {
      // Given: a caller opting in with APP_VERSION
      const { layer } = plannerIn({
        keys: ['MESSAGE'],
        versionEnv: Option.some('APP_VERSION'),
      })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: the references come first, then the short sha as a plain line
      expect(plan.env).toBe(
        [
          "MESSAGE='${{vault.infisical-demo./demo/hello:MESSAGE}}'",
          `APP_VERSION=${testCommit.slice(0, 12)}`,
          '',
        ].join('\n'),
      )
      expect(plan.version).toEqual(
        Option.some({ key: 'APP_VERSION', value: testCommit.slice(0, 12) }),
      )
      expect(plan.keys).toEqual(['MESSAGE'])
    }),
  )

  effect(
    'should find no change on the same commit, and only the version on a new one',
    () =>
      Effect.gen(function* () {
        // Given: Dokploy holding the block written for the first commit
        const versionEnv = Option.some('APP_VERSION')
        const first = yield* planWith(
          plannerIn({ versionEnv, keys: ['MESSAGE'] }).layer,
        )
        const nextCommit = 'fedcba9876543210fedcba9876543210fedcba98'

        // When: planning again for that commit, then for the next one
        const plans = yield* Effect.all([
          planWith(
            plannerIn({ versionEnv, keys: ['MESSAGE'], currentEnv: first.env })
              .layer,
          ),
          planWith(
            plannerIn({
              versionEnv,
              keys: ['MESSAGE'],
              currentEnv: first.env,
              commit: Option.some(nextCommit),
            }).layer,
          ),
        ])

        // Then: a re-run writes nothing; a new commit changes the version line only
        expect(plans[0].changes.env.drift).toBe(false)
        expect(plans[1].changes.env).toEqual({
          drift: true,
          added: [],
          removed: [],
          changed: ['APP_VERSION'],
        })
      }),
  )

  effect('should add the version line to an env written before opting in', () =>
    Effect.gen(function* () {
      // Given: Dokploy holding the references alone, from a run without version-env
      const before = yield* planWith(plannerIn({ keys: ['MESSAGE'] }).layer)
      const { layer } = plannerIn({
        keys: ['MESSAGE'],
        currentEnv: before.env,
        versionEnv: Option.some('APP_VERSION'),
      })

      // When: planning with version-env
      const plan = yield* planWith(layer)

      // Then: the version key is the only addition
      expect(plan.changes.env).toEqual({
        drift: true,
        added: ['APP_VERSION'],
        removed: [],
        changed: [],
      })
    }),
  )

  effect(
    'should accept the version variable without a default in the compose',
    () =>
      Effect.gen(function* () {
        // Given: a compose file reading ${APP_VERSION} with no default
        const compose = {
          ...demoCompose,
          requiredVariables: ['MESSAGE', 'APP_VERSION'],
        }
        const { layer } = plannerIn({
          compose,
          versionEnv: Option.some('APP_VERSION'),
        })

        // When: planning
        const plan = yield* planWith(layer)

        // Then: the action provides it, so the plan passes
        expect(plan.version).toEqual(
          Option.some({ key: 'APP_VERSION', value: testCommit.slice(0, 12) }),
        )
      }),
  )

  effect(
    'should fail when the folder holds a secret named like version-env',
    () =>
      Effect.gen(function* () {
        // Given: a secrets folder listing APP_VERSION
        const { layer } = plannerIn({
          keys: ['APP_VERSION', 'MESSAGE'],
          versionEnv: Option.some('APP_VERSION'),
        })

        // When: planning
        const error = yield* Effect.flip(planWith(layer))

        // Then: the plan fails rather than writing the key twice
        expect(error).toEqual(
          VersionKeyCollisionError.forKey({
            key: 'APP_VERSION',
            provider: 'infisical-demo',
            folder: '/demo/hello',
          }),
        )
      }),
  )

  effect(
    'should refuse version-env without a commit before calling Dokploy',
    () =>
      Effect.gen(function* () {
        // Given: version-env set while the commit check is off
        const { layer, dokployCalls } = plannerIn({
          versionEnv: Option.some('APP_VERSION'),
          commit: Option.none(),
        })

        // When: planning
        const error = yield* Effect.flip(planWith(layer))

        // Then: it fails on the inputs, without spending a Dokploy request
        expect(error).toEqual(VersionWithoutCommitError.forKey('APP_VERSION'))
        expect(dokployCalls).toEqual([])
      }),
  )
})

const openBaoEnvironment: ManifestEnvironment = {
  dokploy: { project: 'Demo', environment: 'production', compose: 'hello' },
  secrets: {
    openbao: {
      'demo-prod': {
        MESSAGE: 'prod/hello:MESSAGE',
        HELLO_URL: 'https://${prod/hello:HELLO_HOST}/',
      },
      'shared-prod': { NPM_TOKEN: 'prod/npm-registry:token' },
    },
  },
  domain: 'demo.example.com',
}

const openBaoManifest: Manifest = {
  version: 1,
  composeFile: 'docker-compose.dokploy.yml',
  environments: { production: openBaoEnvironment },
  domains: demoManifest.domains,
}

const openBaoProviders: ReadonlyArray<VaultProvider> = [
  {
    vaultProviderId: 'provider-demo-prod',
    name: 'demo-prod',
    providerType: 'hashicorp',
    config: { mount: 'demo' },
  },
  {
    vaultProviderId: 'provider-shared-prod',
    name: 'shared-prod',
    providerType: 'hashicorp',
    config: { mount: 'shared', namespace: '' },
  },
  demoProvider,
]

const openBaoListings: Readonly<Record<string, ReadonlyArray<string>>> = {
  'provider-demo-prod': ['prod/hello:HELLO_HOST', 'prod/hello:MESSAGE'],
  'provider-shared-prod': ['prod/npm-registry:token'],
}

interface OpenBaoWorld {
  readonly manifest?: Manifest
  readonly providers?: ReadonlyArray<VaultProvider>
  readonly listings?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly states?: Readonly<Record<string, SecretState>>
  readonly metadata?: boolean
  readonly versionEnv?: Option.Option<string>
}

function openBaoPlannerIn({
  manifest = openBaoManifest,
  providers = openBaoProviders,
  listings = openBaoListings,
  states = {},
  metadata = false,
  versionEnv = Option.none(),
}: OpenBaoWorld) {
  const queries: Array<SecretNamesQuery> = []
  const metadataReads: Array<string> = []
  const layer = DeploymentPlanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionInputs.buildTestLayer({ versionEnv }),
        OpenBaoMetadata.buildTestLayer({
          enabled: metadata,
          secretState: ({ mount, path, namespace }) =>
            Effect.sync(() => {
              metadataReads.push(
                `${Option.getOrElse(namespace, () => '')}|${mount}/${path}`,
              )
              return states[`${mount}/${path}`] ?? 'live'
            }),
        }),
        WorkspaceFiles.buildTestLayer({
          readManifest: () => Effect.succeed(manifest),
          readCompose: () =>
            Effect.succeed({
              ...demoCompose,
              requiredVariables: ['MESSAGE', 'NPM_TOKEN'],
            }),
        }),
        DokployClient.buildTestLayer({
          projects: Effect.succeed(demoProjects),
          vaultProviders: Effect.succeed(providers),
          listSecretNames: (query) =>
            Effect.sync(() => {
              queries.push(query)
              return listings[query.vaultProviderId] ?? []
            }),
        }),
      ),
    ),
  )
  return { layer, queries, metadataReads }
}

describe('DeploymentPlanner with OpenBao secrets', () => {
  effect('should render the explicit mapping as OpenBao references', () =>
    Effect.gen(function* () {
      // Given: Demo mapping keys to its own provider and to shared-prod
      const { layer, queries } = openBaoPlannerIn({})

      // When: planning
      const plan = yield* planWith(layer)

      // Then: each key references its provider, path and field; composed values keep their text
      expect(plan.env).toBe(
        [
          "HELLO_URL='https://${{vault.demo-prod.prod/hello:HELLO_HOST}}/'",
          "MESSAGE='${{vault.demo-prod.prod/hello:MESSAGE}}'",
          "NPM_TOKEN='${{vault.shared-prod.prod/npm-registry:token}}'",
          '',
        ].join('\n'),
      )
      expect(plan.keys).toEqual(['HELLO_URL', 'MESSAGE', 'NPM_TOKEN'])
      expect(plan.secrets).toEqual({
        kind: 'openbao',
        metadataChecked: false,
        providers: [
          {
            name: 'demo-prod',
            mount: 'demo',
            references: ['prod/hello:HELLO_HOST', 'prod/hello:MESSAGE'],
          },
          {
            name: 'shared-prod',
            mount: 'shared',
            references: ['prod/npm-registry:token'],
          },
        ],
      })
      expect(plan.unverifiedReferences).toEqual([])
      expect(queries.map(({ vaultProviderId }) => vaultProviderId)).toEqual([
        'provider-demo-prod',
        'provider-shared-prod',
      ])
      expect(queries[0]?.environmentId).toBe('environment-production')
    }),
  )

  effect('should refuse an Infisical provider in the OpenBao form', () =>
    Effect.gen(function* () {
      // Given: the mapping naming the Infisical provider
      const manifest: Manifest = {
        ...openBaoManifest,
        environments: {
          production: {
            ...openBaoEnvironment,
            secrets: { openbao: { 'infisical-demo': { MESSAGE: 'p/x:y' } } },
          },
        },
      }
      const { layer } = openBaoPlannerIn({ manifest })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the provider type is refused
      expect(error).toBeInstanceOf(VaultProviderError)
      expect(error.message).toContain('HashiCorp Vault / OpenBao')
    }),
  )

  effect('should refuse a provider reading another application mount', () =>
    Effect.gen(function* () {
      // Given: demo-prod pointed at Octant's mount
      const providers = openBaoProviders.map((provider) =>
        provider.name === 'demo-prod'
          ? { ...provider, config: { mount: 'octant' } }
          : provider,
      )
      const { layer, queries } = openBaoPlannerIn({ providers })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the guard stops it before listing any secret
      expect(error).toEqual(
        MountGuardError.outside({
          provider: 'demo-prod',
          mount: 'octant',
          project: 'Demo',
        }),
      )
      expect(queries).toEqual([])
    }),
  )

  effect('should fail on a reference the provider does not list', () =>
    Effect.gen(function* () {
      // Given: the shared provider missing the npm token
      const { layer } = openBaoPlannerIn({
        listings: { ...openBaoListings, 'provider-shared-prod': ['x:y'] },
      })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the missing reference is named, by path and field only
      expect(error).toEqual(
        MissingSecretReferencesError.forReferences({
          provider: 'shared-prod',
          references: ['prod/npm-registry:token'],
          listed: 1,
        }),
      )
    }),
  )

  effect('should fail when the compose needs a key the mapping lacks', () =>
    Effect.gen(function* () {
      // Given: a mapping without NPM_TOKEN, which the compose requires
      const manifest: Manifest = {
        ...openBaoManifest,
        environments: {
          production: {
            ...openBaoEnvironment,
            secrets: {
              openbao: { 'demo-prod': { MESSAGE: 'prod/hello:MESSAGE' } },
            },
          },
        },
      }
      const { layer } = openBaoPlannerIn({ manifest })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the compose check names it
      expect(error).toEqual(
        MissingComposeVariablesError.forVariables({
          compose: 'docker-compose.dokploy.yml',
          variables: ['NPM_TOKEN'],
        }),
      )
    }),
  )

  effect('should check each path in OpenBao metadata with a token', () =>
    Effect.gen(function* () {
      // Given: an openbao-token
      const { layer, metadataReads } = openBaoPlannerIn({ metadata: true })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: each distinct path was read once, in its provider's mount
      expect([...metadataReads].sort()).toEqual([
        '|demo/prod/hello',
        '|shared/prod/npm-registry',
      ])
      expect(
        plan.secrets.kind === 'openbao' && plan.secrets.metadataChecked,
      ).toBe(true)
    }),
  )

  effect('should fail on a path without a live version in OpenBao', () =>
    Effect.gen(function* () {
      // Given: the npm token's current version deleted
      const { layer } = openBaoPlannerIn({
        metadata: true,
        states: { 'shared/prod/npm-registry': 'deleted' },
      })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the path and its state are named
      expect(error).toEqual(
        OpenBaoSecretStateError.forSecrets([
          { location: 'shared/prod/npm-registry', state: 'deleted' },
        ]),
      )
    }),
  )

  effect('should only warn when the provider listing is truncated', () =>
    Effect.gen(function* () {
      // Given: Dokploy listing 200 other entries for demo-prod
      const listings = {
        ...openBaoListings,
        'provider-demo-prod': Array.from(
          { length: 200 },
          (_, index) => `prod/other-${index}:value`,
        ),
      }
      const { layer } = openBaoPlannerIn({ listings })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: the references it could not see are reported, the plan goes on
      expect(plan.unverifiedReferences).toEqual([
        'demo-prod:prod/hello:HELLO_HOST',
        'demo-prod:prod/hello:MESSAGE',
      ])
    }),
  )

  effect('should refuse a version-env the mapping holds', () =>
    Effect.gen(function* () {
      // Given: version-env named like a mapped key
      const { layer } = openBaoPlannerIn({
        versionEnv: Option.some('MESSAGE'),
      })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the collision is reported
      expect(error).toEqual(VersionKeyMappedError.forKey('MESSAGE'))
    }),
  )
})

describe('DeploymentPlanner with plain values', () => {
  effect('should write the plain values among the OpenBao references', () =>
    Effect.gen(function* () {
      // Given: an OpenBao environment whose MESSAGE moved to a plain value
      const manifest: Manifest = {
        ...openBaoManifest,
        environments: {
          production: {
            ...openBaoEnvironment,
            secrets: {
              openbao: {
                'shared-prod': { NPM_TOKEN: 'prod/npm-registry:token' },
              },
            },
            env: { MESSAGE: 'hello', APP_ENVIRONMENT: 'production' },
          },
        },
      }
      const { layer } = openBaoPlannerIn({ manifest })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: the plain values satisfy the compose and are written as they are
      expect(plan.env).toBe(
        [
          "APP_ENVIRONMENT='production'",
          "MESSAGE='hello'",
          "NPM_TOKEN='${{vault.shared-prod.prod/npm-registry:token}}'",
          '',
        ].join('\n'),
      )
      expect(plan.keys).toEqual(['NPM_TOKEN', 'APP_ENVIRONMENT', 'MESSAGE'])
      expect(plan.plainKeys).toEqual(['APP_ENVIRONMENT', 'MESSAGE'])
    }),
  )

  effect('should write the plain values among the Infisical references', () =>
    Effect.gen(function* () {
      // Given: an Infisical environment with a plain value
      const manifest: Manifest = {
        ...demoManifest,
        environments: {
          production: {
            dokploy: {
              project: 'Demo',
              environment: 'production',
              compose: 'hello',
            },
            env: { APP_ENVIRONMENT: 'production' },
            domain: 'demo.example.com',
          },
        },
      }
      const { layer } = plannerIn({ manifest, keys: ['MESSAGE'] })

      // When: planning
      const plan = yield* planWith(layer)

      // Then: the folder's key and the plain value are both written, sorted
      expect(plan.env).toBe(
        [
          "APP_ENVIRONMENT='production'",
          "MESSAGE='${{vault.infisical-demo./demo/hello:MESSAGE}}'",
          '',
        ].join('\n'),
      )
      expect(plan.plainKeys).toEqual(['APP_ENVIRONMENT'])
    }),
  )

  effect('should report a key that is both plain and mapped', () =>
    Effect.gen(function* () {
      // Given: MESSAGE both mapped from OpenBao and given as a plain value
      const manifest: Manifest = {
        ...openBaoManifest,
        environments: {
          production: { ...openBaoEnvironment, env: { MESSAGE: 'hello' } },
        },
      }
      const { layer, queries } = openBaoPlannerIn({ manifest })

      // When: planning
      const error = yield* Effect.flip(planWith(layer))

      // Then: the collision is named before any provider is listed
      expect(error).toEqual(PlainValueCollisionError.forSecretKeys(['MESSAGE']))
      expect(queries).toEqual([])
    }),
  )
})
