import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer } from 'effect'

import { ActionInputs } from '#action-inputs.config.ts'
import type { ComposeFile } from '#compose/compose-file.ts'
import {
  DeploymentPlanner,
  UnknownEnvironmentError,
} from '#deployment-planner.ts'
import type {
  DokployDomain,
  DokployProject,
  SecretNamesQuery,
  VaultProvider,
} from '#dokploy/dokploy-client.ts'
import { DokployClient } from '#dokploy/dokploy-client.ts'
import {
  MissingComposeVariablesError,
  NoSecretKeysError,
  ReferenceGuardError,
} from '#env/env-references.ts'
import type { Manifest } from '#manifest/manifest.ts'
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
}

function plannerIn({
  manifest = demoManifest,
  compose = demoCompose,
  keys = ['MESSAGE', 'DEMO_IMPORTED', 'DEMO_MESSAGE'],
  environment = 'production',
  currentEnv = '',
  currentDomains = [],
}: FakeWorld) {
  const dokployCalls: Array<string> = []
  const queries: Array<SecretNamesQuery> = []
  const layer = DeploymentPlanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionInputs.buildTestLayer({ environment }),
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
      expect(plan.provider).toBe('infisical-demo')
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
      expect(plan.provider).toBe('infisical-demo')
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
})
