import { Context, Effect, Layer, Match, Schema, pipe } from 'effect'

import type { ActionInputsShape } from '#action-inputs.config.ts'
import { ActionInputs } from '#action-inputs.config.ts'
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

export interface DeployActionShape {
  readonly run: Effect.Effect<void, ApplyUnavailableError>
}

interface DeployActionDependencies {
  readonly inputs: ActionInputsShape
  readonly workflowCommands: WorkflowCommandsShape
}

class NoOpDeployAction implements DeployActionShape {
  readonly run: Effect.Effect<void, ApplyUnavailableError>

  private readonly dependencies: DeployActionDependencies

  private constructor(dependencies: DeployActionDependencies) {
    this.dependencies = dependencies
    this.run = this.runAction()
  }

  static make(dependencies: DeployActionDependencies): NoOpDeployAction {
    return new NoOpDeployAction(dependencies)
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
      Match.when('plan', () =>
        EffectLog.info(
          'DeployAction plan has nothing to compare yet',
          this.target(),
        ),
      ),
      Match.when('apply', () =>
        Effect.fail(ApplyUnavailableError.inThisRelease()),
      ),
      Match.exhaustive,
      Effect.withSpan('DeployAction.runMode'),
    )
  }

  private target() {
    return {
      apiHost: this.dependencies.inputs.apiUrl.host,
      manifest: this.dependencies.inputs.manifest,
      release: 'no-op bootstrap',
    }
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
      }),
      (dependencies) => NoOpDeployAction.make(dependencies),
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
