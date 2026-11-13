import { NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Logger, pipe } from 'effect'

import { ActionInputs } from '#action-inputs.config.ts'
import { DeployAction } from '#deploy-action.ts'
import { WorkflowCommands } from '#workflow-commands.ts'

const actionLayer = Layer.merge(
  DeployAction.layer.pipe(
    Layer.provide(Layer.mergeAll(ActionInputs.layer, WorkflowCommands.layer)),
  ),
  Logger.layer([Logger.consolePretty({ colors: false })]),
)

const program = pipe(
  Effect.service(DeployAction),
  Effect.flatMap(({ run }) => run),
  Effect.provide(actionLayer),
  Effect.withSpan('main'),
)

NodeRuntime.runMain(program)
