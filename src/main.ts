import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Logger, pipe } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { ActionInputs } from '#action-inputs.config.ts'
import { DeployAction } from '#deploy-action.ts'
import { DeploymentPlanner } from '#deployment-planner.ts'
import { DokployClient } from '#dokploy/dokploy-client.ts'
import { WorkflowCommands } from '#workflow-commands.ts'
import { WorkspaceFiles } from '#workspace-files.ts'

const plannerLayer = DeploymentPlanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspaceFiles.layer.pipe(Layer.provide(NodeFileSystem.layer)),
      DokployClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  ),
)

const actionLayer = Layer.merge(
  DeployAction.layer.pipe(
    Layer.provide(plannerLayer),
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
