import { Context, Effect, Layer, Match, Schema, pipe } from 'effect'

import type { ActionInputsShape } from '#action-inputs.config.ts'
import { ActionInputs } from '#action-inputs.config.ts'
import type {
  DeploymentPlan,
  DeploymentPlanError,
  DeploymentPlannerShape,
} from '#deployment-planner.ts'
import { DeploymentPlanner } from '#deployment-planner.ts'
import { EffectLog, EffectService } from '#effect/index.ts'
import type { WorkflowCommandsShape } from '#workflow-commands.ts'
import { WorkflowCommands } from '#workflow-commands.ts'

export class ApplyUnavailableError extends Schema.TaggedError<ApplyUnavailableError>()(
  'ApplyUnavailableError',
  { message: Schema.String },
) {
  static inThisRelease(): ApplyUnavailableError {
    return new ApplyUnavailableError({
      message:
        'mode apply is not available in this release: nothing was changed in Dokploy; use mode plan until v1',
    })
  }
}

export type DeployActionError = ApplyUnavailableError | DeploymentPlanError

export interface DeployActionShape {
  readonly run: Effect.Effect<void, DeployActionError>
}

interface DeployActionDependencies {
  readonly inputs: ActionInputsShape
  readonly workflowCommands: WorkflowCommandsShape
  readonly planner: DeploymentPlannerShape
}

function planAnnotations(plan: DeploymentPlan) {
  return {
    environment: plan.environment,
    project: plan.dokploy.project,
    dokployEnvironment: plan.dokploy.environment,
    compose: plan.dokploy.compose,
    composeId: plan.dokploy.composeId,
    provider: plan.provider,
    folder: plan.folder,
    keys: plan.keys.length,
  }
}

function domainLine({
  host,
  path,
  serviceName,
  port,
  https,
}: DeploymentPlan['domains'][number]) {
  return `${https ? 'https' : 'http'}://${host}${path} -> ${serviceName}:${port}`
}

class ManifestDeployAction implements DeployActionShape {
  readonly run: Effect.Effect<void, DeployActionError>

  private readonly dependencies: DeployActionDependencies

  private constructor(dependencies: DeployActionDependencies) {
    this.dependencies = dependencies
    this.run = this.runAction()
  }

  static make(dependencies: DeployActionDependencies): ManifestDeployAction {
    return new ManifestDeployAction(dependencies)
  }

  private runAction() {
    return pipe(
      this.dependencies.workflowCommands.mask(this.dependencies.inputs.apiKey),
      Effect.andThen(() => this.runMode()),
      Effect.withSpan('DeployAction.run', {
        attributes: { mode: this.dependencies.inputs.mode },
      }),
    )
  }

  private runMode() {
    return pipe(
      Match.value(this.dependencies.inputs.mode),
      Match.when('plan', () => this.plan()),
      Match.when('apply', () =>
        Effect.fail(ApplyUnavailableError.inThisRelease()),
      ),
      Match.exhaustive,
      Effect.withSpan('DeployAction.runMode'),
    )
  }

  private plan() {
    return pipe(
      this.dependencies.planner.plan,
      Effect.tap((plan) =>
        EffectLog.info('DeployAction rendered the environment block', {
          ...planAnnotations(plan),
          env: plan.env,
        }),
      ),
      Effect.tap(({ environment, domains }) =>
        EffectLog.info('DeployAction rendered the domains', {
          environment,
          domains: domains.map(domainLine),
        }),
      ),
      Effect.asVoid,
      Effect.withSpan('DeployAction.plan'),
    )
  }
}

export class DeployAction extends Context.Service<
  DeployAction,
  DeployActionShape
>()('dokploy-deploy/DeployAction') {
  static readonly layer = Layer.effect(
    DeployAction,
    Effect.map(
      EffectService.all({
        inputs: ActionInputs,
        workflowCommands: WorkflowCommands,
        planner: DeploymentPlanner,
      }),
      (dependencies) => ManifestDeployAction.make(dependencies),
    ),
  )

  static readonly buildTestService = (shape: Partial<DeployActionShape> = {}) =>
    DeployAction.of({
      run: Effect.void,
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    DeployAction,
    DeployAction.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<DeployActionShape>,
  ): Layer.Layer<DeployAction> =>
    Layer.succeed(DeployAction, DeployAction.buildTestService(shape))
}
