import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer, Logger, Redacted } from 'effect'

import { ActionInputs } from '#action-inputs.config.ts'
import type { ActionInputsShape } from '#action-inputs.config.ts'
import { ApplyUnavailableError, DeployAction } from '#deploy-action.ts'
import { WorkflowCommands } from '#workflow-commands.ts'

interface RecordedStep {
  readonly kind: 'mask' | 'log'
  readonly detail: string
}

function recordingAction(inputs: Partial<ActionInputsShape>) {
  const steps: Array<RecordedStep> = []
  const recordingLogger = Logger.make(({ logLevel, message }) => {
    steps.push({ kind: 'log', detail: `${logLevel} ${String(message)}` })
  })
  const layer = DeployAction.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionInputs.buildTestLayer(inputs),
        WorkflowCommands.buildTestLayer({
          mask: (secret) =>
            Effect.sync(() => {
              steps.push({ kind: 'mask', detail: Redacted.value(secret) })
            }),
        }),
      ),
    ),
  )
  return {
    steps,
    layer: Layer.merge(layer, Logger.layer([recordingLogger])),
  }
}

describe('DeployAction', () => {
  effect('should mask the api key before anything is logged', () =>
    Effect.gen(function* () {
      // Given: a caller's key
      const apiKey = Redacted.make('caller-dokploy-api-key')
      const { layer, steps } = recordingAction({ apiKey })

      // When: running the action
      yield* DeployAction.pipe(
        Effect.flatMap(({ run }) => run),
        Effect.provide(layer),
      )

      // Then: the first thing written is the mask command for that key
      expect(steps[0]).toEqual({
        kind: 'mask',
        detail: 'caller-dokploy-api-key',
      })
      expect(steps.length).toBeGreaterThan(1)
    }),
  )

  effect('should succeed in plan mode without changing anything', () =>
    Effect.gen(function* () {
      // Given: plan mode
      const mode = 'plan'
      const { layer, steps } = recordingAction({ mode })

      // When: running the action
      yield* DeployAction.pipe(
        Effect.flatMap(({ run }) => run),
        Effect.provide(layer),
      )

      // Then: it reports an empty plan as information
      expect(steps.at(-1)?.detail).toContain('Info')
      expect(steps.at(-1)?.detail).toContain('plan has nothing to compare')
    }),
  )

  effect('should fail in apply mode rather than pass for a deploy', () =>
    Effect.gen(function* () {
      // Given: apply mode, against a release that cannot apply yet
      const mode = 'apply'
      const { layer, steps } = recordingAction({ mode })

      // When: running the action
      const error = yield* Effect.flip(
        DeployAction.pipe(
          Effect.flatMap(({ run }) => run),
          Effect.provide(layer),
        ),
      )

      // Then: the step fails, after masking the key, and changed nothing
      expect(error).toEqual(ApplyUnavailableError.inThisRelease())
      expect(steps.map(({ kind }) => kind)).toEqual(['mask'])
    }),
  )
})
