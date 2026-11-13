import {
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  pipe,
} from 'effect'

import { ActionInputs } from '#action-inputs.config.ts'
import { EffectLog, EffectService } from '#effect/index.ts'

export class WorkflowOutputError extends Schema.TaggedError<WorkflowOutputError>()(
  'WorkflowOutputError',
  { path: Schema.String, message: Schema.String },
) {
  static unwritable({
    path,
    reason,
  }: {
    readonly path: string
    readonly reason: string
  }): WorkflowOutputError {
    return new WorkflowOutputError({
      path,
      message: `the step outputs could not be written to ${path}: ${reason}`,
    })
  }
}

export type StepOutputs = Readonly<Record<string, string>>

export interface WorkflowCommandsShape {
  readonly mask: (secret: Redacted.Redacted<string>) => Effect.Effect<void>
  readonly setOutputs: (
    outputs: StepOutputs,
  ) => Effect.Effect<void, WorkflowOutputError>
}

interface WorkflowCommandsDependencies {
  readonly fileSystem: FileSystem.FileSystem
  readonly outputFile: Option.Option<string>
}

export function escapeCommandData(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
}

export function outputLines(outputs: StepOutputs): string {
  return Object.entries(outputs)
    .map(([name, value]) => `${name}=${value.replaceAll(/[\r\n]+/gu, ' ')}\n`)
    .join('')
}

class ConsoleWorkflowCommands implements WorkflowCommandsShape {
  private readonly dependencies: WorkflowCommandsDependencies

  private constructor(dependencies: WorkflowCommandsDependencies) {
    this.dependencies = dependencies
  }

  static make(
    dependencies: WorkflowCommandsDependencies,
  ): ConsoleWorkflowCommands {
    return new ConsoleWorkflowCommands(dependencies)
  }

  mask(secret: Redacted.Redacted<string>) {
    return pipe(
      // Why: a workflow command is runner protocol on stdout, not a log line — it must reach the runner verbatim, before anything could print the value.
      Console.log(`::add-mask::${escapeCommandData(Redacted.value(secret))}`),
      Effect.withSpan('WorkflowCommands.mask'),
    )
  }

  setOutputs(outputs: StepOutputs) {
    return pipe(
      this.dependencies.outputFile,
      Option.match({
        onNone: () =>
          EffectLog.info('WorkflowCommands has no output file to write', {
            outputs,
          }),
        onSome: (path) => this.appendOutputs({ path, outputs }),
      }),
      Effect.withSpan('WorkflowCommands.setOutputs'),
    )
  }

  private appendOutputs({
    path,
    outputs,
  }: {
    readonly path: string
    readonly outputs: StepOutputs
  }) {
    return pipe(
      this.dependencies.fileSystem.writeFileString(path, outputLines(outputs), {
        flag: 'a',
      }),
      Effect.mapError((cause) =>
        WorkflowOutputError.unwritable({ path, reason: cause.message }),
      ),
      Effect.withSpan('WorkflowCommands.appendOutputs'),
    )
  }
}

export class WorkflowCommands extends Context.Service<
  WorkflowCommands,
  WorkflowCommandsShape
>()('dokploy-deploy/WorkflowCommands') {
  static readonly layer = Layer.effect(
    WorkflowCommands,
    Effect.map(
      EffectService.all({
        fileSystem: FileSystem.FileSystem,
        inputs: ActionInputs,
      }),
      ({ fileSystem, inputs }) =>
        ConsoleWorkflowCommands.make({
          fileSystem,
          outputFile: inputs.outputFile,
        }),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<WorkflowCommandsShape> = {},
  ) =>
    WorkflowCommands.of({
      mask: () => Effect.void,
      setOutputs: () => Effect.void,
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    WorkflowCommands,
    WorkflowCommands.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<WorkflowCommandsShape>,
  ): Layer.Layer<WorkflowCommands> =>
    Layer.succeed(WorkflowCommands, WorkflowCommands.buildTestService(shape))
}
