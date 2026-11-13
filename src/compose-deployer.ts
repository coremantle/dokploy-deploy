import {
  Array as Arr,
  Cause,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Order,
  Ref,
  Schedule,
  Schema,
  pipe,
} from 'effect'

import type {
  DokployClientShape,
  DokployDeployment,
  DokployError,
} from '#dokploy/dokploy-client.ts'
import { DokployClient, DokployRequestError } from '#dokploy/dokploy-client.ts'
import { EffectLog, EffectService } from '#effect/index.ts'

export const pollInterval = Duration.seconds(5)

export const commitGrace = Duration.seconds(30)

export const logTailLines = 50

export const pollRetries = 3

const recordedCommit = /^Commit: ([0-9a-f]{40}|[0-9a-f]{64})$/iu

export const DeploymentReport = Schema.Struct({
  status: Schema.String,
  deploymentId: Schema.optionalKey(Schema.String),
  sha: Schema.optionalKey(Schema.String),
  duration: Schema.optionalKey(Schema.Number),
})

export type DeploymentReport = typeof DeploymentReport.Type

export function quotedLog(log: string): string {
  // Why: the runner reads `::cmd::` at a line start and `##[cmd]` anywhere as workflow commands; what the compose's build printed must stay inert.
  return log
    .split('\n')
    .map((line) => `| ${line.replaceAll('##[', '#\u200B#[')}`)
    .join('\n')
}

export class DeploymentFailedError extends Schema.TaggedError<DeploymentFailedError>()(
  'DeploymentFailedError',
  {
    report: DeploymentReport,
    log: Schema.String,
    message: Schema.String,
  },
) {
  static ended({
    report,
    log,
  }: {
    readonly report: DeploymentReport
    readonly log: string
  }): DeploymentFailedError {
    return new DeploymentFailedError({
      report,
      log,
      message: `Dokploy deployment ${report.deploymentId ?? ''} ended with status ${report.status}; the last lines of its log:\n${quotedLog(log)}`,
    })
  }
}

export class DeploymentTimeoutError extends Schema.TaggedError<DeploymentTimeoutError>()(
  'DeploymentTimeoutError',
  {
    report: DeploymentReport,
    message: Schema.String,
  },
) {
  static after({
    timeout,
    report,
  }: {
    readonly timeout: Duration.Duration
    readonly report: DeploymentReport
  }): DeploymentTimeoutError {
    const seconds = Duration.toSeconds(timeout)
    return new DeploymentTimeoutError({
      report,
      message:
        report.deploymentId === undefined
          ? `Dokploy did not start the deployment within ${seconds} seconds: it is still waiting in Dokploy's queue, shared by every project; raise deploy-timeout if the queue is often this long`
          : `Dokploy deployment ${report.deploymentId} was still ${report.status} after ${seconds} seconds; it goes on in Dokploy, raise deploy-timeout if builds are often this long`,
    })
  }
}

export class DeployedCommitError extends Schema.TaggedError<DeployedCommitError>()(
  'DeployedCommitError',
  {
    report: DeploymentReport,
    expected: Schema.String,
    recorded: Schema.optionalKey(Schema.String),
    message: Schema.String,
  },
) {
  static mismatch({
    report,
    expected,
    recorded,
  }: {
    readonly report: DeploymentReport
    readonly expected: string
    readonly recorded: string
  }): DeployedCommitError {
    return new DeployedCommitError({
      report,
      expected,
      recorded,
      message: `Dokploy deployment ${report.deploymentId ?? ''} deployed commit ${recorded}, not ${expected}: the compose's branch is not at this job's commit (a newer push, another branch, or a source lagging behind)`,
    })
  }

  static unrecorded({
    report,
    expected,
  }: {
    readonly report: DeploymentReport
    readonly expected: string
  }): DeployedCommitError {
    return new DeployedCommitError({
      report,
      expected,
      message: `Dokploy deployment ${report.deploymentId ?? ''} recorded no commit within ${Duration.toSeconds(commitGrace)} seconds of its end, so the deployed commit cannot be verified (is the compose a git source, and was Dokploy reachable?); set commit to an empty string to deploy without the check`,
    })
  }
}

export class DeploymentUnobservedError extends Schema.TaggedError<DeploymentUnobservedError>()(
  'DeploymentUnobservedError',
  {
    report: DeploymentReport,
    message: Schema.String,
  },
) {
  static after({
    report,
    cause,
  }: {
    readonly report: DeploymentReport
    readonly cause: DokployError
  }): DeploymentUnobservedError {
    return new DeploymentUnobservedError({
      report,
      message: `Dokploy deployment ${report.deploymentId ?? ''} (last seen ${report.status}) could no longer be followed after the deploy request: ${cause.message}; check its result in Dokploy`,
    })
  }
}

export type ComposeDeployError =
  | DokployError
  | DeploymentFailedError
  | DeploymentTimeoutError
  | DeployedCommitError
  | DeploymentUnobservedError

function hasReport(
  error: ComposeDeployError,
): error is
  | DeploymentFailedError
  | DeploymentTimeoutError
  | DeployedCommitError
  | DeploymentUnobservedError {
  return (
    error instanceof DeploymentFailedError ||
    error instanceof DeploymentTimeoutError ||
    error instanceof DeployedCommitError ||
    error instanceof DeploymentUnobservedError
  )
}

export function reportOfError(
  error: ComposeDeployError,
): Option.Option<DeploymentReport> {
  return pipe(
    Option.liftPredicate(error, hasReport),
    Option.map(({ report }) => report),
  )
}

export interface DeployRequest {
  readonly composeId: string
  readonly commit: Option.Option<string>
  readonly timeout: Duration.Duration
}

export interface ComposeDeployerShape {
  readonly deploy: (
    request: DeployRequest,
  ) => Effect.Effect<DeploymentReport, ComposeDeployError>
}

interface ComposeDeployerDependencies {
  readonly dokploy: DokployClientShape
}

function isFinished({ status }: DokployDeployment) {
  return status !== null && status !== 'running'
}

function isTransient(error: DokployError) {
  return (
    error instanceof DokployRequestError &&
    (error.status === undefined || error.status === 429 || error.status >= 500)
  )
}

function isFinishedDeployment(found: Option.Option<DokployDeployment>) {
  return Option.exists(found, isFinished)
}

const byCreation = Order.mapInput(
  Order.String,
  ({ createdAt }: DokployDeployment) => createdAt,
)

function firstNew({
  deployments,
  known,
}: {
  readonly deployments: ReadonlyArray<DokployDeployment>
  readonly known: ReadonlySet<string>
}): Option.Option<DokployDeployment> {
  return pipe(
    deployments.filter(({ deploymentId }) => !known.has(deploymentId)),
    Arr.sort(byCreation),
    Arr.head,
  )
}

function commitOf({ description }: DokployDeployment): Option.Option<string> {
  return pipe(
    Option.fromNullishOr(recordedCommit.exec(description ?? '')),
    Option.flatMap((match) => Option.fromUndefinedOr(match[1])),
    Option.map((sha) => sha.toLowerCase()),
  )
}

function durationOf({
  startedAt,
  finishedAt,
}: DokployDeployment): Option.Option<number> {
  return pipe(
    Option.all([
      Option.fromNullishOr(startedAt),
      Option.fromNullishOr(finishedAt),
    ]),
    Option.map(([start, end]) => (Date.parse(end) - Date.parse(start)) / 1000),
    Option.filter((seconds) => Number.isFinite(seconds) && seconds >= 0),
    Option.map((seconds) => Math.round(seconds)),
  )
}

export function reportOf(deployment: DokployDeployment): DeploymentReport {
  return {
    status: deployment.status ?? 'running',
    deploymentId: deployment.deploymentId,
    ...Option.match(durationOf(deployment), {
      onNone: () => ({}),
      onSome: (duration) => ({ duration }),
    }),
  }
}

// oxlint-disable-next-line no-control-regex
const ansiEscape = /\u001B\[[0-9;?]*[A-Za-z]/gu

export function readableLog(log: string): string {
  // Why: git and docker draw progress bars with carriage returns; only what a terminal would finally show is worth printing.
  const lines = log.split('\n').map((line) =>
    pipe(
      Arr.findLast(
        line.replaceAll(ansiEscape, '').split('\r'),
        (segment) => segment.trim() !== '',
      ),
      Option.getOrElse(() => ''),
    ).trimEnd(),
  )
  return lines.join('\n').trimEnd()
}

class DokployComposeDeployer implements ComposeDeployerShape {
  private readonly dependencies: ComposeDeployerDependencies

  private constructor(dependencies: ComposeDeployerDependencies) {
    this.dependencies = dependencies
  }

  static make(
    dependencies: ComposeDeployerDependencies,
  ): DokployComposeDeployer {
    return new DokployComposeDeployer(dependencies)
  }

  deploy(request: DeployRequest) {
    return pipe(
      this.dependencies.dokploy.composeDeployments(request.composeId),
      Effect.map(
        (deployments) =>
          new Set(deployments.map(({ deploymentId }) => deploymentId)),
      ),
      Effect.tap(() => this.requestDeployment(request)),
      Effect.flatMap((known) => this.awaitEnd({ known, request })),
      Effect.flatMap((deployment) => this.settle({ deployment, request })),
      Effect.withSpan('ComposeDeployer.deploy', {
        attributes: { composeId: request.composeId },
      }),
    )
  }

  private requestDeployment({ composeId, timeout }: DeployRequest) {
    return pipe(
      this.dependencies.dokploy.deployCompose(composeId),
      Effect.tap(() =>
        EffectLog.info('ComposeDeployer requested the deployment', {
          composeId,
          timeoutSeconds: Duration.toSeconds(timeout),
        }),
      ),
      Effect.withSpan('ComposeDeployer.requestDeployment', {
        attributes: { composeId },
      }),
    )
  }

  private awaitEnd({
    known,
    request,
  }: {
    readonly known: ReadonlySet<string>
    readonly request: DeployRequest
  }) {
    return pipe(
      Ref.make(Option.none<DokployDeployment>()),
      Effect.flatMap((seen) =>
        this.pollUntilFinished({ known, seen, request }),
      ),
      Effect.withSpan('ComposeDeployer.awaitEnd', {
        attributes: { composeId: request.composeId },
      }),
    )
  }

  private pollUntilFinished({
    known,
    seen,
    request,
  }: {
    readonly known: ReadonlySet<string>
    readonly seen: Ref.Ref<Option.Option<DokployDeployment>>
    readonly request: DeployRequest
  }) {
    return pipe(
      this.observe({ known, seen, composeId: request.composeId }),
      Effect.repeat({
        schedule: Schedule.spaced(pollInterval),
        until: isFinishedDeployment,
      }),
      Effect.flatMap((found) =>
        Option.match(found, {
          // Defect: the repeat above only stops on a finished deployment.
          onNone: () => Effect.die('the wait ended without a deployment'),
          onSome: (deployment) => Effect.succeed(deployment),
        }),
      ),
      Effect.catch((error: DokployError) => this.lostSight({ seen, error })),
      Effect.timeoutOrElse({
        duration: request.timeout,
        orElse: () => this.timedOut({ seen, timeout: request.timeout }),
      }),
      Effect.withSpan('ComposeDeployer.pollUntilFinished', {
        attributes: { composeId: request.composeId },
      }),
    )
  }

  private lostSight({
    seen,
    error,
  }: {
    readonly seen: Ref.Ref<Option.Option<DokployDeployment>>
    readonly error: DokployError
  }) {
    return pipe(
      Ref.get(seen),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              DeploymentUnobservedError.after({
                report: { status: 'queued' },
                cause: error,
              }),
            ),
          onSome: (deployment) =>
            Effect.fail(
              DeploymentUnobservedError.after({
                report: reportOf(deployment),
                cause: error,
              }),
            ),
        }),
      ),
      Effect.withSpan('ComposeDeployer.lostSight'),
    )
  }

  private timedOut({
    seen,
    timeout,
  }: {
    readonly seen: Ref.Ref<Option.Option<DokployDeployment>>
    readonly timeout: Duration.Duration
  }) {
    return pipe(
      Ref.get(seen),
      Effect.flatMap((last) =>
        Effect.fail(
          DeploymentTimeoutError.after({
            timeout,
            report: Option.match(last, {
              onNone: () => ({ status: 'queued' }),
              onSome: reportOf,
            }),
          }),
        ),
      ),
      Effect.withSpan('ComposeDeployer.timedOut'),
    )
  }

  private observe({
    known,
    seen,
    composeId,
  }: {
    readonly known: ReadonlySet<string>
    readonly seen: Ref.Ref<Option.Option<DokployDeployment>>
    readonly composeId: string
  }) {
    return pipe(
      this.pollDeployments(composeId),
      Effect.flatMap((deployments) => this.track({ deployments, known, seen })),
      Effect.tap((found) => this.notePickup({ found, seen })),
      Effect.withSpan('ComposeDeployer.observe', { attributes: { composeId } }),
    )
  }

  private track({
    deployments,
    known,
    seen,
  }: {
    readonly deployments: ReadonlyArray<DokployDeployment>
    readonly known: ReadonlySet<string>
    readonly seen: Ref.Ref<Option.Option<DokployDeployment>>
  }) {
    // Why: once its deployment is seen, the action follows that id — never another deployment created later.
    return pipe(
      Ref.get(seen),
      Effect.map(
        Option.match({
          onNone: () => firstNew({ deployments, known }),
          onSome: ({ deploymentId }) =>
            Arr.findFirst(
              deployments,
              (deployment) => deployment.deploymentId === deploymentId,
            ),
        }),
      ),
      Effect.withSpan('ComposeDeployer.track'),
    )
  }

  private pollDeployments(composeId: string) {
    // Why: one poll among hundreds hitting a proxy hiccup must not fail a deploy that goes on in Dokploy; a refusal or a bad answer still fails at once.
    return pipe(
      this.dependencies.dokploy.composeDeployments(composeId),
      Effect.tapError((error) =>
        isTransient(error)
          ? EffectLog.warning(
              'ComposeDeployer met a transient error while polling',
              { composeId, retries: pollRetries, cause: Cause.fail(error) },
            )
          : Effect.void,
      ),
      Effect.retry({
        times: pollRetries,
        schedule: Schedule.spaced(pollInterval),
        while: isTransient,
      }),
      Effect.withSpan('ComposeDeployer.pollDeployments', {
        attributes: { composeId },
      }),
    )
  }

  private notePickup({
    found,
    seen,
  }: {
    readonly found: Option.Option<DokployDeployment>
    readonly seen: Ref.Ref<Option.Option<DokployDeployment>>
  }) {
    // Why: a later list that misses the deployment must not make it look unseen again.
    return pipe(
      Ref.getAndUpdate(seen, (previous) =>
        Option.orElse(found, () => previous),
      ),
      Effect.flatMap((previous) =>
        Option.isNone(previous) && Option.isSome(found)
          ? EffectLog.info('ComposeDeployer saw Dokploy start the deployment', {
              deploymentId: found.value.deploymentId,
            })
          : Effect.void,
      ),
      Effect.withSpan('ComposeDeployer.notePickup'),
    )
  }

  private settle({
    deployment,
    request,
  }: {
    readonly deployment: DokployDeployment
    readonly request: DeployRequest
  }): Effect.Effect<DeploymentReport, ComposeDeployError> {
    return pipe(
      deployment.status === 'done'
        ? this.verifyCommit({ deployment, request })
        : this.failWithLog(deployment),
      Effect.withSpan('ComposeDeployer.settle', {
        attributes: {
          deploymentId: deployment.deploymentId,
          status: deployment.status ?? 'running',
        },
      }),
    )
  }

  private failWithLog(deployment: DokployDeployment) {
    return pipe(
      this.dependencies.dokploy.deploymentLog({
        deploymentId: deployment.deploymentId,
        tail: logTailLines,
      }),
      Effect.map(readableLog),
      Effect.catch((error: DokployError) =>
        Effect.succeed(`(the log could not be read: ${error.message})`),
      ),
      Effect.flatMap((log) =>
        Effect.fail(
          DeploymentFailedError.ended({ log, report: reportOf(deployment) }),
        ),
      ),
      Effect.withSpan('ComposeDeployer.failWithLog', {
        attributes: { deploymentId: deployment.deploymentId },
      }),
    )
  }

  private verifyCommit({
    deployment,
    request,
  }: {
    readonly deployment: DokployDeployment
    readonly request: DeployRequest
  }): Effect.Effect<DeploymentReport, ComposeDeployError> {
    return pipe(
      request.commit,
      Option.match({
        onNone: () => this.skipCommitCheck(deployment),
        onSome: (expected) =>
          this.checkCommit({
            deployment,
            expected,
            composeId: request.composeId,
          }),
      }),
      Effect.withSpan('ComposeDeployer.verifyCommit', {
        attributes: { deploymentId: deployment.deploymentId },
      }),
    )
  }

  private skipCommitCheck(deployment: DokployDeployment) {
    return pipe(
      EffectLog.warning(
        'ComposeDeployer did not check the deployed commit: commit is empty',
        { deploymentId: deployment.deploymentId },
      ),
      Effect.as(reportOf(deployment)),
      Effect.withSpan('ComposeDeployer.skipCommitCheck'),
    )
  }

  private checkCommit({
    deployment,
    expected,
    composeId,
  }: {
    readonly deployment: DokployDeployment
    readonly expected: string
    readonly composeId: string
  }) {
    const report = reportOf(deployment)
    return pipe(
      this.awaitCommit({ deployment, composeId }),
      Effect.catch((error: DokployError) =>
        Effect.fail(DeploymentUnobservedError.after({ report, cause: error })),
      ),
      Effect.flatMap((recorded) =>
        Option.match(recorded, {
          onNone: () =>
            Effect.fail(DeployedCommitError.unrecorded({ report, expected })),
          onSome: (sha) =>
            sha === expected
              ? Effect.succeed({ ...report, sha })
              : Effect.fail(
                  DeployedCommitError.mismatch({
                    report,
                    expected,
                    recorded: sha,
                  }),
                ),
        }),
      ),
      Effect.withSpan('ComposeDeployer.checkCommit', {
        attributes: { deploymentId: deployment.deploymentId },
      }),
    )
  }

  private awaitCommit({
    deployment,
    composeId,
  }: {
    readonly deployment: DokployDeployment
    readonly composeId: string
  }) {
    const recorded = commitOf(deployment)
    return pipe(
      Option.isSome(recorded)
        ? Effect.succeed(recorded)
        : this.readCommitLater({ deployment, composeId }),
      Effect.withSpan('ComposeDeployer.awaitCommit', {
        attributes: { deploymentId: deployment.deploymentId },
      }),
    )
  }

  private readCommitLater({
    composeId,
    deployment: { deploymentId },
  }: {
    readonly deployment: DokployDeployment
    readonly composeId: string
  }) {
    // Why: Dokploy marks the deployment done, then records its commit in a `finally` — a read right at the end can still see an empty description.
    return pipe(
      Effect.sleep(pollInterval),
      Effect.andThen(() => this.pollDeployments(composeId)),
      Effect.map((deployments) =>
        Option.flatMap(
          Option.fromUndefinedOr(
            deployments.find((found) => found.deploymentId === deploymentId),
          ),
          commitOf,
        ),
      ),
      Effect.repeat({
        schedule: Schedule.spaced(pollInterval),
        until: Option.isSome,
      }),
      Effect.timeoutOrElse({
        duration: commitGrace,
        orElse: () => Effect.succeed(Option.none<string>()),
      }),
      Effect.withSpan('ComposeDeployer.readCommitLater', {
        attributes: { deploymentId },
      }),
    )
  }
}

export class ComposeDeployer extends Context.Service<
  ComposeDeployer,
  ComposeDeployerShape
>()('dokploy-deploy/ComposeDeployer') {
  static readonly layer = Layer.effect(
    ComposeDeployer,
    Effect.map(EffectService.all({ dokploy: DokployClient }), (dependencies) =>
      DokployComposeDeployer.make(dependencies),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<ComposeDeployerShape> = {},
  ) =>
    ComposeDeployer.of({
      deploy: ({ commit }) =>
        Effect.succeed({
          status: 'done',
          deploymentId: 'test-deployment-id',
          duration: 12,
          ...Option.match(commit, {
            onNone: () => ({}),
            onSome: (sha) => ({ sha }),
          }),
        }),
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    ComposeDeployer,
    ComposeDeployer.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<ComposeDeployerShape>,
  ): Layer.Layer<ComposeDeployer> =>
    Layer.succeed(ComposeDeployer, ComposeDeployer.buildTestService(shape))
}
