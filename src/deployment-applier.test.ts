import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'

import { DeploymentApplier } from '#deployment-applier.ts'
import type { DeploymentPlan } from '#deployment-planner.ts'
import { DeploymentPlanner } from '#deployment-planner.ts'
import type { DesiredDomain } from '#domains/desired-domains.ts'
import { UnsupportedAllowedMethodsError } from '#domains/desired-domains.ts'
import { diffDomains } from '#domains/domain-diff.ts'
import type { DokployDomain } from '#dokploy/dokploy-client.ts'
import { DokployClient, DokployRequestError } from '#dokploy/dokploy-client.ts'
import { diffEnv } from '#env/env-diff.ts'

const web: DesiredDomain = {
  host: 'app.demo.example.com',
  serviceName: 'web',
  port: 3000,
  path: '/',
  https: true,
  certificateType: 'letsencrypt',
}

const desiredEnv = "MESSAGE='${{vault.infisical-demo./demo:MESSAGE}}'\n"

const basePlan = Effect.runSync(DeploymentPlanner.buildTestService().plan)

interface FakeDokploy {
  env: string
  domains: Array<DokployDomain>
  readonly writes: Array<string>
}

function fakeDokploy({
  env,
  domains,
}: {
  readonly env: string
  readonly domains: ReadonlyArray<DokployDomain>
}): FakeDokploy {
  return { env, domains: [...domains], writes: [] }
}

function planAgainst({
  world,
  desired = [web],
  unsupported = [],
}: {
  readonly world: FakeDokploy
  readonly desired?: ReadonlyArray<DesiredDomain>
  readonly unsupported?: ReadonlyArray<string>
}): DeploymentPlan {
  return {
    ...basePlan,
    unsupported,
    env: desiredEnv,
    domains: desired,
    changes: {
      env: diffEnv({ current: world.env, desired: desiredEnv }),
      domains: diffDomains({ desired, current: world.domains }),
    },
  }
}

function applierLayer(world: FakeDokploy) {
  return DeploymentApplier.layer.pipe(
    Layer.provide(
      DokployClient.buildTestLayer({
        saveEnvironment: ({ env }) =>
          Effect.sync(() => {
            world.writes.push('compose.saveEnvironment')
            world.env = env
          }),
        createDomain: ({ composeId: _composeId, ...settings }) =>
          Effect.sync(() => {
            world.writes.push(`domain.create ${settings.host}`)
            world.domains.push({
              domainId: `domain-${settings.host}`,
              ...settings,
            })
          }),
        updateDomain: ({ domainId, ...settings }) =>
          Effect.sync(() => {
            world.writes.push(`domain.update ${domainId}`)
            world.domains = world.domains.map((domain) =>
              domain.domainId === domainId ? { domainId, ...settings } : domain,
            )
          }),
        deleteDomain: (domainId) =>
          Effect.sync(() => {
            world.writes.push(`domain.delete ${domainId}`)
            world.domains = world.domains.filter(
              (domain) => domain.domainId !== domainId,
            )
          }),
      }),
    ),
  )
}

function applyTo({
  world,
  plan,
}: {
  readonly world: FakeDokploy
  readonly plan: DeploymentPlan
}) {
  return DeploymentApplier.pipe(
    Effect.flatMap((applier) => applier.apply(plan)),
    Effect.provide(applierLayer(world)),
    Effect.withSpan('DeploymentApplierTest.apply'),
  )
}

describe('DeploymentApplier', () => {
  effect(
    'should converge the env and the domains, then do nothing the second time',
    () =>
      Effect.gen(function* () {
        // Given: a stale env, web on the wrong port and a domain the manifest dropped
        const world = fakeDokploy({
          env: 'MESSAGE=literal\n',
          domains: [
            {
              domainId: 'domain-web',
              host: web.host,
              path: '/',
              port: 8080,
              serviceName: 'web',
              https: true,
              certificateType: 'letsencrypt',
            },
            {
              domainId: 'domain-old',
              host: 'old.demo.example.com',
              path: '/',
              port: 3000,
              serviceName: 'old',
              https: true,
              certificateType: 'letsencrypt',
            },
          ],
        })
        const api = { ...web, host: 'api.demo.example.com', port: 4000 }

        // When: applying, then planning and applying again
        const first = yield* applyTo({
          world,
          plan: planAgainst({ world, desired: [web, api] }),
        })
        const firstWrites = [...world.writes]
        world.writes.length = 0
        const second = yield* applyTo({
          world,
          plan: planAgainst({ world, desired: [web, api] }),
        })

        // Then: the first run writes each change once, deletions last; the second writes nothing
        expect(firstWrites).toEqual([
          'compose.saveEnvironment',
          'domain.update domain-web',
          'domain.create api.demo.example.com',
          'domain.delete domain-old',
        ])
        expect(first).toEqual({ env: true, created: 1, updated: 1, deleted: 1 })
        expect(world.writes).toEqual([])
        expect(second).toEqual({
          env: false,
          created: 0,
          updated: 0,
          deleted: 0,
        })
        expect(world.env).toBe(desiredEnv)
      }),
  )

  effect('should refuse allowedMethods before writing anything', () =>
    Effect.gen(function* () {
      // Given: a manifest restricting the methods of a domain
      const world = fakeDokploy({ env: '', domains: [] })
      const plan = planAgainst({
        world,
        unsupported: ['app.demo.example.com/'],
      })

      // When: applying
      const error = yield* Effect.flip(applyTo({ world, plan }))

      // Then: it fails loudly and Dokploy is untouched
      expect(error).toBeInstanceOf(UnsupportedAllowedMethodsError)
      expect(error.message).toContain('app.demo.example.com/')
      expect(world.writes).toEqual([])
    }),
  )

  effect('should stop at the first write Dokploy refuses', () =>
    Effect.gen(function* () {
      // Given: Dokploy refusing the env write
      const failure = DokployRequestError.fromStatus({
        endpoint: 'compose.saveEnvironment',
        status: 403,
        dokployMessage: Option.some('Permission denied'),
      })
      const world = fakeDokploy({ env: '', domains: [] })
      const plan = planAgainst({ world })
      const writes: Array<string> = []
      const layer = DeploymentApplier.layer.pipe(
        Layer.provide(
          DokployClient.buildTestLayer({
            saveEnvironment: () => Effect.fail(failure),
            createDomain: () =>
              Effect.sync(() => {
                writes.push('domain.create')
              }),
          }),
        ),
      )

      // When: applying
      const error = yield* Effect.flip(
        DeploymentApplier.pipe(
          Effect.flatMap((applier) => applier.apply(plan)),
          Effect.provide(layer),
        ),
      )

      // Then: the error is Dokploy's, and no domain is written after it
      expect(error).toEqual(failure)
      expect(writes).toEqual([])
    }),
  )
})
