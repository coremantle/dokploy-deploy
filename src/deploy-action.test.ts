import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer, Logger, Redacted, References } from 'effect'

import { ActionInputs } from '#action-inputs.config.ts'
import type { ActionInputsShape } from '#action-inputs.config.ts'
import { ApplyUnavailableError, DeployAction } from '#deploy-action.ts'
import {
  DeploymentPlanner,
  UnknownEnvironmentError,
} from '#deployment-planner.ts'
import type { DeploymentPlannerShape } from '#deployment-planner.ts'
import { WorkflowCommands } from '#workflow-commands.ts'

interface RecordedStep {
  readonly kind: 'mask' | 'log' | 'plan'
  readonly detail: string
}

function recordPlan(steps: Array<RecordedStep>) {
  return Effect.sync(() => {
    steps.push({ kind: 'plan', detail: 'planned' })
  })
}

function recordingAction({
  inputs = {},
  planner = {},
}: {
  readonly inputs?: Partial<ActionInputsShape>
  readonly planner?: Partial<DeploymentPlannerShape>
}) {
  const steps: Array<RecordedStep> = []
  const recordingLogger = Logger.make(({ logLevel, message, fiber }) => {
    const annotations = JSON.stringify(
      fiber.getRef(References.CurrentLogAnnotations),
    )
    steps.push({
      kind: 'log',
      detail: `${logLevel} ${String(message)} ${annotations}`,
    })
  })
  const testPlanner = DeploymentPlanner.buildTestService(planner)
  const recordedPlanner = DeploymentPlanner.buildTestLayer({
    plan: Effect.andThen(recordPlan(steps), testPlanner.plan),
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
        recordedPlanner,
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
      const { layer, steps } = recordingAction({ inputs: { apiKey } })

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

  effect('should log the rendered environment block in plan mode', () =>
    Effect.gen(function* () {
      // Given: plan mode
      const { layer, steps } = recordingAction({ inputs: { mode: 'plan' } })

      // When: running the action
      yield* DeployAction.pipe(
        Effect.flatMap(({ run }) => run),
        Effect.provide(layer),
      )

      // Then: it plans once, then reports the references and the domains
      expect(steps.map(({ kind }) => kind)).toEqual([
        'mask',
        'plan',
        'log',
        'log',
      ])
      expect(steps[2]?.detail).toContain('rendered the environment block')
      expect(steps[2]?.detail).toContain('${{vault.demo-prod./demo:MESSAGE}}')
      expect(steps[3]?.detail).toContain('rendered the domains')
    }),
  )

  effect('should fail in plan mode when the plan cannot be built', () =>
    Effect.gen(function* () {
      // Given: a manifest that does not declare the requested environment
      const failure = UnknownEnvironmentError.notDeclared({
        environment: 'staging',
        declared: ['production'],
      })
      const { layer, steps } = recordingAction({
        planner: { plan: Effect.fail(failure) },
      })

      // When: running the action
      const error = yield* Effect.flip(
        DeployAction.pipe(
          Effect.flatMap(({ run }) => run),
          Effect.provide(layer),
        ),
      )

      // Then: the step fails with the planner's error and logs no plan
      expect(error).toEqual(failure)
      expect(steps.map(({ kind }) => kind)).toEqual(['mask', 'plan'])
    }),
  )

  effect('should fail in apply mode rather than pass for a deploy', () =>
    Effect.gen(function* () {
      // Given: apply mode, against a release that cannot apply yet
      const { layer, steps } = recordingAction({ inputs: { mode: 'apply' } })

      // When: running the action
      const error = yield* Effect.flip(
        DeployAction.pipe(
          Effect.flatMap(({ run }) => run),
          Effect.provide(layer),
        ),
      )

      // Then: the step fails, after masking the key, without even planning
      expect(error).toEqual(ApplyUnavailableError.inThisRelease())
      expect(steps.map(({ kind }) => kind)).toEqual(['mask'])
    }),
  )
})
