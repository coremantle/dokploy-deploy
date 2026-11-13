import { Console, Context, Effect, Layer, Redacted, pipe } from 'effect'

export interface WorkflowCommandsShape {
  readonly mask: (secret: Redacted.Redacted<string>) => Effect.Effect<void>
}

export function escapeCommandData(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
}

class ConsoleWorkflowCommands implements WorkflowCommandsShape {
  static make(): ConsoleWorkflowCommands {
    return new ConsoleWorkflowCommands()
  }

  mask(secret: Redacted.Redacted<string>) {
    return pipe(
      // Why: a workflow command is runner protocol on stdout, not a log line — it must reach the runner verbatim, before anything could print the value.
      Console.log(`::add-mask::${escapeCommandData(Redacted.value(secret))}`),
      Effect.withSpan('WorkflowCommands.mask'),
    )
  }
}

export class WorkflowCommands extends Context.Service<
  WorkflowCommands,
  WorkflowCommandsShape
>()('dokploy-deploy/WorkflowCommands') {
  static readonly layer = Layer.succeed(
    WorkflowCommands,
    ConsoleWorkflowCommands.make(),
  )

  static readonly buildTestService = (
    shape: Partial<WorkflowCommandsShape> = {},
  ) =>
    WorkflowCommands.of({
      mask: () => Effect.void,
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
