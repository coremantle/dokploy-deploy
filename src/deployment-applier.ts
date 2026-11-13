import { Context, Effect, Layer, pipe } from 'effect'

import type { DeploymentPlan } from '#deployment-planner.ts'
import { UnsupportedAllowedMethodsError } from '#domains/desired-domains.ts'
import type { DomainUpdate } from '#domains/domain-diff.ts'
import { domainSettings, routeOf } from '#domains/domain-diff.ts'
import type {
  DokployClientShape,
  DokployDomain,
  DokployError,
} from '#dokploy/dokploy-client.ts'
import { DokployClient } from '#dokploy/dokploy-client.ts'
import type { DesiredDomain } from '#domains/desired-domains.ts'
import { EffectLog, EffectService } from '#effect/index.ts'

export interface AppliedChanges {
  readonly env: boolean
  readonly created: number
  readonly updated: number
  readonly deleted: number
}

export type DeploymentApplyError = UnsupportedAllowedMethodsError | DokployError

export interface DeploymentApplierShape {
  readonly apply: (
    plan: DeploymentPlan,
  ) => Effect.Effect<AppliedChanges, DeploymentApplyError>
}

interface DeploymentApplierDependencies {
  readonly dokploy: DokployClientShape
}

class DokployDeploymentApplier implements DeploymentApplierShape {
  private readonly dependencies: DeploymentApplierDependencies

  private constructor(dependencies: DeploymentApplierDependencies) {
    this.dependencies = dependencies
  }

  static make(
    dependencies: DeploymentApplierDependencies,
  ): DokployDeploymentApplier {
    return new DokployDeploymentApplier(dependencies)
  }

  apply(plan: DeploymentPlan) {
    const { domains } = plan.changes
    return pipe(
      Effect.succeed(plan.unsupported),
      Effect.filterOrFail(
        (routes) => routes.length === 0,
        (routes) => UnsupportedAllowedMethodsError.forRoutes(routes),
      ),
      Effect.andThen(() => this.saveEnvironment(plan)),
      Effect.andThen(() =>
        Effect.forEach(domains.update, (update) => this.updateDomain(update), {
          discard: true,
        }),
      ),
      Effect.andThen(() =>
        Effect.forEach(
          domains.create,
          (domain) =>
            this.createDomain({ domain, composeId: plan.dokploy.composeId }),
          { discard: true },
        ),
      ),
      // Why: deletions last — a deleted route is never a desired one, and a failed create must not leave the compose without its old route.
      Effect.andThen(() =>
        Effect.forEach(domains.delete, (domain) => this.deleteDomain(domain), {
          discard: true,
        }),
      ),
      Effect.as({
        env: plan.changes.env.drift,
        created: domains.create.length,
        updated: domains.update.length,
        deleted: domains.delete.length,
      }),
      Effect.withSpan('DeploymentApplier.apply', {
        attributes: { composeId: plan.dokploy.composeId },
      }),
    )
  }

  private saveEnvironment({ changes, dokploy, env }: DeploymentPlan) {
    if (!changes.env.drift) {
      return Effect.void.pipe(
        Effect.withSpan('DeploymentApplier.saveEnvironment'),
      )
    }
    return pipe(
      this.dependencies.dokploy.saveEnvironment({
        env,
        composeId: dokploy.composeId,
      }),
      Effect.tap(() =>
        EffectLog.info('DeploymentApplier saved the environment block', {
          compose: dokploy.compose,
          added: changes.env.added,
          changed: changes.env.changed,
          removed: changes.env.removed,
        }),
      ),
      Effect.withSpan('DeploymentApplier.saveEnvironment'),
    )
  }

  private deleteDomain(domain: DokployDomain) {
    return pipe(
      this.dependencies.dokploy.deleteDomain(domain.domainId),
      Effect.tap(() =>
        EffectLog.info('DeploymentApplier deleted a domain', {
          route: routeOf(domain),
        }),
      ),
      Effect.withSpan('DeploymentApplier.deleteDomain', {
        attributes: { domainId: domain.domainId },
      }),
    )
  }

  private updateDomain({ domainId, desired, fields }: DomainUpdate) {
    return pipe(
      this.dependencies.dokploy.updateDomain({
        domainId,
        ...domainSettings(desired),
      }),
      Effect.tap(() =>
        EffectLog.info('DeploymentApplier updated a domain', {
          fields,
          route: routeOf(desired),
        }),
      ),
      Effect.withSpan('DeploymentApplier.updateDomain', {
        attributes: { domainId },
      }),
    )
  }

  private createDomain({
    domain,
    composeId,
  }: {
    readonly domain: DesiredDomain
    readonly composeId: string
  }) {
    return pipe(
      this.dependencies.dokploy.createDomain({
        composeId,
        ...domainSettings(domain),
      }),
      Effect.tap(() =>
        EffectLog.info('DeploymentApplier created a domain', {
          route: routeOf(domain),
          service: `${domain.serviceName}:${domain.port}`,
        }),
      ),
      Effect.withSpan('DeploymentApplier.createDomain', {
        attributes: { route: routeOf(domain) },
      }),
    )
  }
}

export class DeploymentApplier extends Context.Service<
  DeploymentApplier,
  DeploymentApplierShape
>()('dokploy-deploy/DeploymentApplier') {
  static readonly layer = Layer.effect(
    DeploymentApplier,
    Effect.map(EffectService.all({ dokploy: DokployClient }), (dependencies) =>
      DokployDeploymentApplier.make(dependencies),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<DeploymentApplierShape> = {},
  ) =>
    DeploymentApplier.of({
      apply: () =>
        Effect.succeed({ env: false, created: 0, updated: 0, deleted: 0 }),
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    DeploymentApplier,
    DeploymentApplier.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<DeploymentApplierShape>,
  ): Layer.Layer<DeploymentApplier> =>
    Layer.succeed(DeploymentApplier, DeploymentApplier.buildTestService(shape))
}
