import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer, Logger, Option, Redacted, References } from 'effect'

import { ActionInputs } from '#action-inputs.config.ts'
import type { ActionInputsShape } from '#action-inputs.config.ts'
import { DeployAction } from '#deploy-action.ts'
import { DeploymentApplier } from '#deployment-applier.ts'
import type { DeploymentApplierShape } from '#deployment-applier.ts'
import {
  DeploymentPlanner,
  UnknownEnvironmentError,
} from '#deployment-planner.ts'
import type { DeploymentPlannerShape } from '#deployment-planner.ts'
import { DokployRequestError } from '#dokploy/dokploy-client.ts'
import {
  PullRequestCommentError,
  PullRequestComments,
} from '#pull-request-comments.ts'
import type { PullRequestCommentsShape } from '#pull-request-comments.ts'
import { WorkflowCommands } from '#workflow-commands.ts'

interface RecordedStep {
  readonly kind: 'mask' | 'log' | 'plan' | 'apply' | 'comment'
  readonly detail: string
}

const onPullRequest: Partial<ActionInputsShape> = {
  forge: {
    apiUrl: Option.some(new URL('https://api.github.com')),
    repository: Option.some('coremantle/demo'),
    pullRequest: Option.some(12),
  },
  token: Option.some(Redacted.make('test-forge-token')),
}

function recordingAction({
  inputs = {},
  planner = {},
  applier = {},
  comments = {},
}: {
  readonly inputs?: Partial<ActionInputsShape>
  readonly planner?: Partial<DeploymentPlannerShape>
  readonly applier?: Partial<DeploymentApplierShape>
  readonly comments?: Partial<PullRequestCommentsShape>
}) {
  const steps: Array<RecordedStep> = []
  function record(step: RecordedStep) {
    return Effect.sync(() => {
      steps.push(step)
    })
  }
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
  const testApplier = DeploymentApplier.buildTestService(applier)
  const testComments = PullRequestComments.buildTestService(comments)
  const services = Layer.mergeAll(
    ActionInputs.buildTestLayer(inputs),
    WorkflowCommands.buildTestLayer({
      mask: (secret) =>
        record({ kind: 'mask', detail: Redacted.value(secret) }),
    }),
    DeploymentPlanner.buildTestLayer({
      plan: Effect.andThen(
        record({ kind: 'plan', detail: 'planned' }),
        testPlanner.plan,
      ),
    }),
    DeploymentApplier.buildTestLayer({
      apply: (plan) =>
        Effect.andThen(
          record({ kind: 'apply', detail: plan.dokploy.composeId }),
          testApplier.apply(plan),
        ),
    }),
    PullRequestComments.buildTestLayer({
      upsert: (comment) =>
        Effect.andThen(
          record({ kind: 'comment', detail: comment.body }),
          testComments.upsert(comment),
        ),
    }),
  )
  const layer = DeployAction.layer.pipe(Layer.provide(services))
  return {
    steps,
    layer: Layer.merge(layer, Logger.layer([recordingLogger])),
  }
}

function runAction(layer: Layer.Layer<DeployAction>) {
  return DeployAction.pipe(
    Effect.flatMap(({ run }) => run),
    Effect.provide(layer),
    Effect.withSpan('DeployActionTest.run'),
  )
}

function kinds(steps: ReadonlyArray<RecordedStep>) {
  return steps.map(({ kind }) => kind).filter((kind) => kind !== 'log')
}

describe('DeployAction', () => {
  effect('should mask the api key before anything is logged', () =>
    Effect.gen(function* () {
      // Given: a caller's key
      const apiKey = Redacted.make('caller-dokploy-api-key')
      const { layer, steps } = recordingAction({ inputs: { apiKey } })

      // When: running the action
      yield* runAction(layer)

      // Then: the first thing written is the mask command for that key
      expect(steps[0]).toEqual({
        kind: 'mask',
        detail: 'caller-dokploy-api-key',
      })
      expect(steps.length).toBeGreaterThan(1)
    }),
  )

  effect('should mask the forge token right after the api key', () =>
    Effect.gen(function* () {
      // Given: a run with a forge token
      const { layer, steps } = recordingAction({ inputs: onPullRequest })

      // When: running the action
      yield* runAction(layer)

      // Then: both secrets are masked before planning
      expect(steps.slice(0, 3)).toEqual([
        { kind: 'mask', detail: 'test-dokploy-api-key' },
        { kind: 'mask', detail: 'test-forge-token' },
        { kind: 'plan', detail: 'planned' },
      ])
    }),
  )

  effect('should log the block, the domains and the changes in plan mode', () =>
    Effect.gen(function* () {
      // Given: plan mode outside a pull request
      const { layer, steps } = recordingAction({ inputs: { mode: 'plan' } })

      // When: running the action
      yield* runAction(layer)

      // Then: it plans once, reports, and neither applies nor comments
      expect(kinds(steps)).toEqual(['mask', 'plan'])
      const logs = steps.filter(({ kind }) => kind === 'log')
      expect(logs[0]?.detail).toContain('rendered the environment block')
      expect(logs[0]?.detail).toContain('${{vault.demo-prod./demo:MESSAGE}}')
      expect(logs[1]?.detail).toContain('rendered the domains')
      expect(logs[2]?.detail).toContain('found nothing to change')
    }),
  )

  effect('should comment the plan on a pull request', () =>
    Effect.gen(function* () {
      // Given: plan mode on a pull request
      const { layer, steps } = recordingAction({
        inputs: { mode: 'plan', ...onPullRequest },
      })

      // When: running the action
      yield* runAction(layer)

      // Then: the report is commented, never applied
      expect(kinds(steps)).toEqual(['mask', 'mask', 'plan', 'comment'])
      const comment = steps.find(({ kind }) => kind === 'comment')
      expect(comment?.detail).toContain(
        '<!-- dokploy-deploy:plan:production:test-compose-id -->',
      )
    }),
  )

  effect('should not comment when pr-comment is false', () =>
    Effect.gen(function* () {
      // Given: plan mode on a pull request, comments turned off
      const { layer, steps } = recordingAction({
        inputs: { mode: 'plan', ...onPullRequest, prComment: false },
      })

      // When: running the action
      yield* runAction(layer)

      // Then: the plan is only logged
      expect(kinds(steps)).toEqual(['mask', 'mask', 'plan'])
    }),
  )

  effect('should fail when the comment cannot be posted', () =>
    Effect.gen(function* () {
      // Given: a forge refusing the comment
      const failure = PullRequestCommentError.fromStatus({
        endpoint: 'issues/12/comments',
        status: 403,
        forgeMessage: Option.some('Resource not accessible by integration'),
      })
      const { layer } = recordingAction({
        inputs: { mode: 'plan', ...onPullRequest },
        comments: { upsert: () => Effect.fail(failure) },
      })

      // When: running the action
      const error = yield* Effect.flip(runAction(layer))

      // Then: the step fails with the forge's answer
      expect(error).toEqual(failure)
      expect(error.message).toContain('pull-requests: write')
    }),
  )

  effect('should fail when the plan cannot be built', () =>
    Effect.gen(function* () {
      // Given: a manifest that does not declare the requested environment
      const failure = UnknownEnvironmentError.notDeclared({
        environment: 'staging',
        declared: ['production'],
      })
      const { layer, steps } = recordingAction({
        inputs: { mode: 'apply', ...onPullRequest },
        planner: { plan: Effect.fail(failure) },
      })

      // When: running the action
      const error = yield* Effect.flip(runAction(layer))

      // Then: the step fails with the planner's error, without applying or commenting
      expect(error).toEqual(failure)
      expect(kinds(steps)).toEqual(['mask', 'mask', 'plan'])
    }),
  )

  effect('should apply the plan in apply mode, without commenting', () =>
    Effect.gen(function* () {
      // Given: apply mode, even on a pull request
      const { layer, steps } = recordingAction({
        inputs: { mode: 'apply', ...onPullRequest },
      })

      // When: running the action
      yield* runAction(layer)

      // Then: the plan is applied once and reported as no change
      expect(kinds(steps)).toEqual(['mask', 'mask', 'plan', 'apply'])
      expect(steps.at(-1)?.detail).toContain('changed nothing')
    }),
  )

  effect('should fail in apply mode when Dokploy refuses a write', () =>
    Effect.gen(function* () {
      // Given: Dokploy refusing compose.saveEnvironment
      const failure = DokployRequestError.fromStatus({
        endpoint: 'compose.saveEnvironment',
        status: 403,
        dokployMessage: Option.some('Permission denied'),
      })
      const { layer } = recordingAction({
        inputs: { mode: 'apply' },
        applier: { apply: () => Effect.fail(failure) },
      })

      // When: running the action
      const error = yield* Effect.flip(runAction(layer))

      // Then: the step fails with the endpoint, status and message
      expect(error).toEqual(failure)
    }),
  )
})
