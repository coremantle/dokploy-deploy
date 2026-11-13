import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Logger, pipe } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { ActionInputs } from '#action-inputs.config.ts'
import { ComposeDeployer } from '#compose-deployer.ts'
import { DeployAction } from '#deploy-action.ts'
import { DeploymentApplier } from '#deployment-applier.ts'
import { DeploymentPlanner } from '#deployment-planner.ts'
import { DokployClient } from '#dokploy/dokploy-client.ts'
import { PullRequestComments } from '#pull-request-comments.ts'
import { WorkflowCommands } from '#workflow-commands.ts'
import { WorkspaceFiles } from '#workspace-files.ts'

const dokployLayer = DokployClient.layer.pipe(
  Layer.provide(FetchHttpClient.layer),
)

const plannerLayer = DeploymentPlanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspaceFiles.layer.pipe(Layer.provide(NodeFileSystem.layer)),
      dokployLayer,
    ),
  ),
)

const applierLayer = DeploymentApplier.layer.pipe(Layer.provide(dokployLayer))

const deployerLayer = ComposeDeployer.layer.pipe(Layer.provide(dokployLayer))

const commentsLayer = PullRequestComments.layer.pipe(
  Layer.provide(FetchHttpClient.layer),
)

const actionLayer = Layer.merge(
  DeployAction.layer.pipe(
    Layer.provide(
      Layer.mergeAll(plannerLayer, applierLayer, deployerLayer, commentsLayer),
    ),
    Layer.provide(
      WorkflowCommands.layer.pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.provideMerge(ActionInputs.layer),
      ),
    ),
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
