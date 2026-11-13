import { describe, effect, expect, it } from '@effect/vitest'
import { Duration, Effect, Exit, Fiber, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'

import {
  ComposeDeployer,
  DeployedCommitError,
  DeploymentFailedError,
  DeploymentTimeoutError,
  DeploymentUnobservedError,
  logTailLines,
  quotedLog,
  readableLog,
} from '#compose-deployer.ts'
import type { DeployRequest } from '#compose-deployer.ts'
import type {
  DokployDeployment,
  DokployError,
} from '#dokploy/dokploy-client.ts'
import {
  DokployClient,
  DokployRequestError,
  DokployUnauthorizedError,
} from '#dokploy/dokploy-client.ts'

const commit = '2f0be93668d4e0f84da0e89a01a8a084a743b08b'

const otherCommit = '1e4ec9029cb1434370a2754668ef9bdd3b4bd2d3'

const previous: DokployDeployment = {
  deploymentId: 'deployment-previous',
  status: 'done',
  description: `Commit: ${otherCommit}`,
  createdAt: '2026-11-13T18:00:00.000Z',
  startedAt: '2026-11-13T18:00:00.000Z',
  finishedAt: '2026-11-13T18:00:02.000Z',
}

function deployment(
  fields: Partial<DokployDeployment> = {},
): DokployDeployment {
  return {
    deploymentId: 'deployment-new',
    status: 'running',
    description: '',
    createdAt: '2026-11-13T19:00:00.000Z',
    startedAt: '2026-11-13T19:00:00.000Z',
    finishedAt: null,
    ...fields,
  }
}

const done = deployment({
  status: 'done',
  description: `Commit: ${commit}`,
  finishedAt: '2026-11-13T19:00:42.400Z',
})

interface FakeDokploy {
  readonly calls: Array<string>
}

function isRefusal(
  answer: ReadonlyArray<DokployDeployment> | DokployError,
): answer is DokployError {
  return !Array.isArray(answer)
}

function fakeDokploy({
  answers,
  log = Effect.succeed(''),
}: {
  readonly answers: ReadonlyArray<
    ReadonlyArray<DokployDeployment> | DokployError
  >
  readonly log?: Effect.Effect<string, DokployRequestError>
}) {
  const world: FakeDokploy = { calls: [] }
  const layer = ComposeDeployer.layer.pipe(
    Layer.provide(
      DokployClient.buildTestLayer({
        composeDeployments: (composeId) =>
          Effect.flatMap(
            Effect.sync(() => {
              const reads = world.calls.filter((call) =>
                call.startsWith('deployment.allByCompose'),
              ).length
              world.calls.push(`deployment.allByCompose ${composeId}`)
              return answers[Math.min(reads, answers.length - 1)] ?? []
            }),
            (answer) =>
              isRefusal(answer) ? Effect.fail(answer) : Effect.succeed(answer),
          ),
        deployCompose: (composeId) =>
          Effect.sync(() => {
            world.calls.push(`compose.deploy ${composeId}`)
          }),
        deploymentLog: ({ deploymentId, tail }) =>
          Effect.andThen(
            Effect.sync(() => {
              world.calls.push(`deployment.readLogs ${deploymentId} ${tail}`)
            }),
            log,
          ),
      }),
    ),
  )
  return { world, layer }
}

function request(fields: Partial<DeployRequest> = {}): DeployRequest {
  return {
    composeId: 'compose-hello',
    commit: Option.some(commit),
    timeout: Duration.minutes(30),
    ...fields,
  }
}

function deployFor({
  layer,
  deployRequest,
  elapsed = '30 minutes',
}: {
  readonly layer: ReturnType<typeof fakeDokploy>['layer']
  readonly deployRequest: DeployRequest
  readonly elapsed?: Duration.Input
}) {
  return Effect.gen(function* () {
    const fiber = yield* ComposeDeployer.pipe(
      Effect.flatMap((deployer) => deployer.deploy(deployRequest)),
      Effect.provide(layer),
      Effect.exit,
      Effect.forkChild,
    )
    yield* TestClock.adjust(elapsed)
    return yield* Fiber.join(fiber)
  })
}

describe('ComposeDeployer', () => {
  effect('should deploy and report the commit Dokploy deployed', () =>
    Effect.gen(function* () {
      // Given: a deployment waiting in the queue, then running, then done
      const { world, layer } = fakeDokploy({
        answers: [
          [previous],
          [previous],
          [deployment(), previous],
          [done, previous],
        ],
      })

      // When: deploying the job's commit
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the report holds the new deployment, its verified sha and its duration
      expect(exit).toEqual(
        Exit.succeed({
          status: 'done',
          deploymentId: 'deployment-new',
          duration: 42,
          sha: commit,
        }),
      )
      expect(world.calls.slice(0, 2)).toEqual([
        'deployment.allByCompose compose-hello',
        'compose.deploy compose-hello',
      ])
    }),
  )

  effect('should ignore a deployment that existed before the request', () =>
    Effect.gen(function* () {
      // Given: another deployment of the compose already running when the action asks
      const running = deployment({ deploymentId: 'deployment-running' })
      const { layer } = fakeDokploy({
        answers: [
          [running],
          [{ ...running, status: 'done' }],
          [done, { ...running, status: 'done' }],
        ],
      })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: only the deployment created after the request counts
      const report = yield* exit
      expect(report.deploymentId).toBe('deployment-new')
    }),
  )

  effect('should wait for the commit Dokploy records after the end', () =>
    Effect.gen(function* () {
      // Given: Dokploy marking the deployment done before writing its commit
      const ended = deployment({
        status: 'done',
        finishedAt: '2026-11-13T19:00:05.000Z',
      })
      const { layer } = fakeDokploy({
        answers: [[], [ended], [ended], [done]],
      })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the sha read a moment later is verified
      const report = yield* exit
      expect(report.sha).toBe(commit)
    }),
  )

  effect('should fail with the tail of the log when the deployment fails', () =>
    Effect.gen(function* () {
      // Given: Dokploy ending the deployment in error, the cause only in its log
      const failed = deployment({
        status: 'error',
        finishedAt: '2026-11-13T19:00:02.000Z',
      })
      const { world, layer } = fakeDokploy({
        answers: [[], [failed]],
        log: Effect.succeed(
          'Receiving objects:  50% (2/4)\rReceiving objects: 100% (4/4), done.\nInfisical: secret "MISSING" not found at "/demo/hello" in environment "prod"\nError occurred ❌, check the logs for details.\n\n',
        ),
      })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the step fails with Dokploy's own words, progress bars collapsed
      const log =
        'Receiving objects: 100% (4/4), done.\nInfisical: secret "MISSING" not found at "/demo/hello" in environment "prod"\nError occurred ❌, check the logs for details.'
      const error = yield* Effect.flip(exit)
      expect(error).toEqual(
        DeploymentFailedError.ended({
          log,
          report: {
            status: 'error',
            deploymentId: 'deployment-new',
            duration: 2,
          },
        }),
      )
      expect(world.calls).toContain(
        `deployment.readLogs deployment-new ${logTailLines}`,
      )
    }),
  )

  effect(
    'should still fail when the log of a failed deployment cannot be read',
    () =>
      Effect.gen(function* () {
        // Given: a cancelled deployment whose log Dokploy refuses
        const cancelled = deployment({ status: 'cancelled' })
        const { layer } = fakeDokploy({
          answers: [[], [cancelled]],
          log: Effect.fail(
            DokployRequestError.fromStatus({
              endpoint: 'deployment.readLogs',
              status: 500,
              dokployMessage: Option.none(),
            }),
          ),
        })

        // When: deploying
        const exit = yield* deployFor({ layer, deployRequest: request() })

        // Then: the deployment failure is reported, with why its log is missing
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(DeploymentFailedError)
        expect(error.message).toContain('ended with status cancelled')
        expect(error.message).toContain(
          'the log could not be read: Dokploy answered 500 on deployment.readLogs',
        )
      }),
  )

  effect('should fail when another commit was deployed', () =>
    Effect.gen(function* () {
      // Given: Dokploy deploying a commit other than the job's
      const stale = { ...done, description: `Commit: ${otherCommit}` }
      const { layer } = fakeDokploy({ answers: [[], [stale]] })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the step fails, naming both commits, and reports no sha
      const error = yield* Effect.flip(exit)
      expect(error).toEqual(
        DeployedCommitError.mismatch({
          report: {
            status: 'done',
            deploymentId: 'deployment-new',
            duration: 42,
          },
          expected: commit,
          recorded: otherCommit,
        }),
      )
    }),
  )

  effect('should fail when Dokploy records no commit', () =>
    Effect.gen(function* () {
      // Given: a deployment that never records a commit (not a git source)
      const bare = { ...done, description: '' }
      const { layer } = fakeDokploy({ answers: [[], [bare]] })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the step fails instead of claiming an unverified commit
      const error = yield* Effect.flip(exit)
      expect(error).toBeInstanceOf(DeployedCommitError)
      expect(error.message).toContain('cannot be verified')
    }),
  )

  effect('should not check the commit when none is expected', () =>
    Effect.gen(function* () {
      // Given: a deployment without a recorded commit, and no expected commit
      const bare = { ...done, description: '' }
      const { layer } = fakeDokploy({ answers: [[], [bare]] })

      // When: deploying without a commit
      const exit = yield* deployFor({
        layer,
        deployRequest: request({ commit: Option.none() }),
      })

      // Then: the deployment succeeds and reports no sha
      expect(exit).toEqual(
        Exit.succeed({
          status: 'done',
          deploymentId: 'deployment-new',
          duration: 42,
        }),
      )
    }),
  )

  effect('should time out while the deployment waits in the queue', () =>
    Effect.gen(function* () {
      // Given: a queue that never picks the deployment up
      const { layer } = fakeDokploy({ answers: [[previous]] })

      // When: the timeout goes by
      const exit = yield* deployFor({
        layer,
        deployRequest: request({ timeout: Duration.minutes(5) }),
        elapsed: '5 minutes',
      })

      // Then: the step fails, reported as still queued
      const error = yield* Effect.flip(exit)
      expect(error).toEqual(
        DeploymentTimeoutError.after({
          timeout: Duration.minutes(5),
          report: { status: 'queued' },
        }),
      )
      expect(error.message).toContain("Dokploy's queue")
    }),
  )

  effect('should time out while the deployment runs', () =>
    Effect.gen(function* () {
      // Given: a deployment that never ends
      const { layer } = fakeDokploy({ answers: [[], [deployment()]] })

      // When: the timeout goes by
      const exit = yield* deployFor({
        layer,
        deployRequest: request({ timeout: Duration.minutes(5) }),
        elapsed: '5 minutes',
      })

      // Then: the step fails, naming the running deployment
      const error = yield* Effect.flip(exit)
      expect(error).toBeInstanceOf(DeploymentTimeoutError)
      expect(error.message).toContain(
        'deployment-new was still running after 300 seconds',
      )
    }),
  )
  effect('should poll again after a transient Dokploy error', () =>
    Effect.gen(function* () {
      // Given: one poll answered by a proxy 502 while the deployment runs
      const { layer } = fakeDokploy({
        answers: [
          [],
          [deployment()],
          DokployRequestError.fromStatus({
            endpoint: 'deployment.allByCompose',
            status: 502,
            dokployMessage: Option.none(),
          }),
          [done],
        ],
      })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the hiccup is absorbed and the verified commit reported
      const report = yield* exit
      expect(report.sha).toBe(commit)
    }),
  )

  effect('should fail at once when Dokploy refuses a poll', () =>
    Effect.gen(function* () {
      // Given: the key rejected while waiting
      const refusal = DokployUnauthorizedError.from({
        endpoint: 'deployment.allByCompose',
        dokployMessage: Option.some('Unauthorized'),
      })
      const { world, layer } = fakeDokploy({
        answers: [[], refusal, [done]],
      })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the refusal fails the step without another poll, saying the request was sent
      const error = yield* Effect.flip(exit)
      expect(error).toEqual(
        DeploymentUnobservedError.after({
          report: { status: 'queued' },
          cause: refusal,
        }),
      )
      expect(
        world.calls.filter((call) =>
          call.startsWith('deployment.allByCompose'),
        ),
      ).toHaveLength(2)
    }),
  )

  effect('should report the deployment it lost sight of', () =>
    Effect.gen(function* () {
      // Given: the key rejected after the deployment started
      const refusal = DokployUnauthorizedError.from({
        endpoint: 'deployment.allByCompose',
        dokployMessage: Option.some('Unauthorized'),
      })
      const { layer } = fakeDokploy({
        answers: [[], [deployment()], refusal],
      })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the failure still names the deployment, for the outputs
      const error = yield* Effect.flip(exit)
      expect(error).toEqual(
        DeploymentUnobservedError.after({
          report: { status: 'running', deploymentId: 'deployment-new' },
          cause: refusal,
        }),
      )
    }),
  )

  effect('should keep following the deployment it saw first', () =>
    Effect.gen(function* () {
      // Given: its deployment missing from one list while a newer one appears
      const newer = deployment({
        deploymentId: 'deployment-newer',
        status: 'error',
        createdAt: '2026-11-13T19:00:30.000Z',
      })
      const { layer } = fakeDokploy({
        answers: [[], [deployment()], [newer], [done, newer]],
      })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the newer deployment is never taken for its own
      const report = yield* exit
      expect(report.deploymentId).toBe('deployment-new')
      expect(report.sha).toBe(commit)
    }),
  )

  effect('should report the deployment when its commit cannot be read', () =>
    Effect.gen(function* () {
      // Given: a deployment ended done, then Dokploy refusing the commit read
      const ended = deployment({
        status: 'done',
        finishedAt: '2026-11-13T19:00:05.000Z',
      })
      const refusal = DokployUnauthorizedError.from({
        endpoint: 'deployment.allByCompose',
        dokployMessage: Option.some('Unauthorized'),
      })
      const { layer } = fakeDokploy({ answers: [[], [ended], refusal] })

      // When: deploying
      const exit = yield* deployFor({ layer, deployRequest: request() })

      // Then: the step fails without claiming a commit, keeping the deployment's report
      const error = yield* Effect.flip(exit)
      expect(error).toBeInstanceOf(DeploymentUnobservedError)
      expect(error).toMatchObject({
        report: { status: 'done', deploymentId: 'deployment-new', duration: 5 },
      })
    }),
  )

  effect(
    'should treat a status it does not know as the end of the deployment',
    () =>
      Effect.gen(function* () {
        // Given: a status a later Dokploy might add
        const skipped = deployment({ status: 'skipped' })
        const { layer } = fakeDokploy({ answers: [[], [skipped]] })

        // When: deploying
        const exit = yield* deployFor({ layer, deployRequest: request() })

        // Then: the step fails with that status instead of waiting for the timeout
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(DeploymentFailedError)
        expect(error.message).toContain('ended with status skipped')
      }),
  )
})

describe('quotedLog', () => {
  it('should keep log lines from reading as workflow commands', () => {
    // Given: a build printing a workflow command
    const log = '::stop-commands::token\nok ##[add-mask]x'

    // When: quoting it for the job log
    const quoted = quotedLog(log)

    // Then: no line starts with ::
    expect(quoted).toBe('| ::stop-commands::token\n| ok #\u200B#[add-mask]x')
  })
})

describe('readableLog', () => {
  it('should keep what a terminal would show of each line', () => {
    // Given: a log with progress bars and trailing blank lines
    const log = 'a 1%\ra 100%\r\u001B[2K\nb  \nerror: crlf\r\n\n'

    // When: making it readable
    const readable = readableLog(log)

    // Then: each line keeps its last carriage-return segment, trailing blanks dropped
    expect(readable).toBe('a 100%\nb\nerror: crlf')
  })
})
