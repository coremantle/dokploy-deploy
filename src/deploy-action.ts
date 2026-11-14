import { Cause, Context, Effect, Layer, Match, Option, pipe } from 'effect'

import type { ActionInputsShape } from '#action-inputs.config.ts'
import { ActionInputs } from '#action-inputs.config.ts'
import type {
  ComposeDeployError,
  ComposeDeployerShape,
  DeploymentReport,
} from '#compose-deployer.ts'
import { ComposeDeployer, reportOfError } from '#compose-deployer.ts'
import type {
  AppliedChanges,
  DeploymentApplierShape,
  DeploymentApplyError,
} from '#deployment-applier.ts'
import { DeploymentApplier } from '#deployment-applier.ts'
import type {
  DeploymentPlan,
  DeploymentPlanError,
  DeploymentPlannerShape,
} from '#deployment-planner.ts'
import { DeploymentPlanner } from '#deployment-planner.ts'
import { routerHostLine } from '#compose/compose-file.ts'
import { domainLine } from '#domains/domain-diff.ts'
import { EffectLog, EffectService } from '#effect/index.ts'
import { hasChanges, planMarker, renderPlanReport } from '#plan-report.ts'
import type {
  PullRequestCommentError,
  PullRequestCommentsShape,
} from '#pull-request-comments.ts'
import { PullRequestComments } from '#pull-request-comments.ts'
import type {
  WorkflowCommandsShape,
  WorkflowOutputError,
} from '#workflow-commands.ts'
import { WorkflowCommands } from '#workflow-commands.ts'

export type DeployActionError =
  | DeploymentPlanError
  | DeploymentApplyError
  | PullRequestCommentError
  | ComposeDeployError

export interface DeployActionShape {
  readonly run: Effect.Effect<void, DeployActionError>
}

interface DeployActionDependencies {
  readonly inputs: ActionInputsShape
  readonly workflowCommands: WorkflowCommandsShape
  readonly planner: DeploymentPlannerShape
  readonly applier: DeploymentApplierShape
  readonly comments: PullRequestCommentsShape
  readonly deployer: ComposeDeployerShape
}

function planAnnotations(plan: DeploymentPlan) {
  return {
    environment: plan.environment,
    project: plan.dokploy.project,
    dokployEnvironment: plan.dokploy.environment,
    compose: plan.dokploy.compose,
    composeId: plan.dokploy.composeId,
    provider: plan.provider,
    folder: plan.folder,
    keys: plan.keys.length,
  }
}

export function stepOutputs(report: DeploymentReport) {
  return {
    'deployment-id': report.deploymentId ?? '',
    status: report.status,
    sha: report.sha ?? '',
    duration: report.duration === undefined ? '' : String(report.duration),
  }
}

function changeAnnotations({ changes: { env, domains } }: DeploymentPlan) {
  return {
    envDrift: env.drift,
    envAdded: env.added,
    envChanged: env.changed,
    envRemoved: env.removed,
    domainsCreated: domains.create.map(domainLine),
    domainsUpdated: domains.update.map(
      ({ desired, fields }) => `${domainLine(desired)} (${fields.join(', ')})`,
    ),
    domainsDeleted: domains.delete.map(domainLine),
    domainsUnchanged: domains.unchanged.length,
  }
}

class ManifestDeployAction implements DeployActionShape {
  readonly run: Effect.Effect<void, DeployActionError>

  private readonly dependencies: DeployActionDependencies

  private constructor(dependencies: DeployActionDependencies) {
    this.dependencies = dependencies
    this.run = this.runAction()
  }

  static make(dependencies: DeployActionDependencies): ManifestDeployAction {
    return new ManifestDeployAction(dependencies)
  }

  private runAction() {
    const { inputs, workflowCommands } = this.dependencies
    return pipe(
      workflowCommands.mask(inputs.apiKey),
      Effect.andThen(() =>
        Option.match(inputs.token, {
          onNone: () => Effect.void,
          onSome: (token) => workflowCommands.mask(token),
        }),
      ),
      Effect.andThen(() => this.dependencies.planner.plan),
      Effect.tap((plan) => this.report(plan)),
      Effect.flatMap((plan) => this.runMode(plan)),
      Effect.withSpan('DeployAction.run', {
        attributes: { mode: inputs.mode },
      }),
    )
  }

  private report(plan: DeploymentPlan) {
    return pipe(
      EffectLog.info('DeployAction rendered the environment block', {
        ...planAnnotations(plan),
        env: plan.env,
      }),
      Effect.andThen(() =>
        EffectLog.info('DeployAction rendered the domains', {
          environment: plan.environment,
          domains: plan.domains.map(domainLine),
        }),
      ),
      Effect.andThen(() =>
        EffectLog.info(
          hasChanges(plan)
            ? 'DeployAction found changes to apply'
            : 'DeployAction found nothing to change',
          { environment: plan.environment, ...changeAnnotations(plan) },
        ),
      ),
      Effect.andThen(() =>
        plan.unsupported.length === 0
          ? Effect.void
          : EffectLog.warning(
              'DeployAction found allowedMethods, which apply refuses',
              { routes: plan.unsupported },
            ),
      ),
      Effect.andThen(() =>
        plan.strayRouterHosts.length === 0
          ? Effect.void
          : EffectLog.warning(
              'DeployAction found Traefik router hosts the manifest does not declare',
              {
                environment: plan.environment,
                hosts: plan.strayRouterHosts.map(routerHostLine),
              },
            ),
      ),
      Effect.withSpan('DeployAction.report'),
    )
  }

  private runMode(plan: DeploymentPlan) {
    return pipe(
      Match.value(this.dependencies.inputs.mode),
      Match.when('plan', () => this.comment(plan)),
      Match.when('apply', () => this.apply(plan)),
      Match.exhaustive,
      Effect.withSpan('DeployAction.runMode'),
    )
  }

  private comment(plan: DeploymentPlan) {
    const { inputs, comments } = this.dependencies
    const onPullRequest =
      inputs.prComment && Option.isSome(inputs.forge.pullRequest)
    return pipe(
      onPullRequest
        ? pipe(
            comments.upsert({
              marker: planMarker(plan),
              body: renderPlanReport(plan),
            }),
            Effect.tap(() =>
              EffectLog.info(
                'DeployAction commented the plan on the pull request',
                {
                  environment: plan.environment,
                },
              ),
            ),
          )
        : Effect.void,
      Effect.withSpan('DeployAction.comment', {
        attributes: { onPullRequest },
      }),
    )
  }

  private apply(plan: DeploymentPlan) {
    return pipe(
      this.dependencies.applier.apply(plan),
      Effect.tap((applied: AppliedChanges) =>
        EffectLog.info(
          hasChanges(plan)
            ? 'DeployAction applied the changes'
            : 'DeployAction changed nothing',
          { environment: plan.environment, ...applied },
        ),
      ),
      Effect.andThen(() =>
        this.dependencies.inputs.deploy
          ? this.deploy(plan)
          : EffectLog.info('DeployAction did not deploy: deploy is false', {
              environment: plan.environment,
            }),
      ),
      Effect.withSpan('DeployAction.apply'),
    )
  }

  private deploy({ environment, dokploy }: DeploymentPlan) {
    const { inputs, deployer } = this.dependencies
    return pipe(
      deployer.deploy({
        composeId: dokploy.composeId,
        commit: inputs.commit,
        timeout: inputs.deployTimeout,
      }),
      Effect.tapError((error) =>
        Option.match(reportOfError(error), {
          onNone: () => Effect.void,
          onSome: (report) => this.writeOutputs(report),
        }),
      ),
      Effect.tap((report) => this.writeOutputs(report)),
      Effect.tap((report) =>
        EffectLog.info(
          report.sha === undefined
            ? 'DeployAction deployed the compose, commit not checked'
            : 'DeployAction deployed the expected commit',
          { environment, compose: dokploy.compose, ...report },
        ),
      ),
      Effect.asVoid,
      Effect.withSpan('DeployAction.deploy', {
        attributes: { composeId: dokploy.composeId },
      }),
    )
  }

  private writeOutputs(report: DeploymentReport) {
    return pipe(
      this.dependencies.workflowCommands.setOutputs(stepOutputs(report)),
      // Why: the outputs only report what happened in Dokploy; failing on them would turn a good deployment red, or hide why a bad one failed.
      Effect.catch((error: WorkflowOutputError) =>
        EffectLog.warning('DeployAction could not write the step outputs', {
          cause: Cause.fail(error),
        }),
      ),
      Effect.withSpan('DeployAction.writeOutputs'),
    )
  }
}

export class DeployAction extends Context.Service<
  DeployAction,
  DeployActionShape
>()('dokploy-deploy/DeployAction') {
  static readonly layer = Layer.effect(
    DeployAction,
    Effect.map(
      EffectService.all({
        inputs: ActionInputs,
        workflowCommands: WorkflowCommands,
        planner: DeploymentPlanner,
        applier: DeploymentApplier,
        comments: PullRequestComments,
        deployer: ComposeDeployer,
      }),
      (dependencies) => ManifestDeployAction.make(dependencies),
    ),
  )

  static readonly buildTestService = (shape: Partial<DeployActionShape> = {}) =>
    DeployAction.of({
      run: Effect.void,
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    DeployAction,
    DeployAction.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<DeployActionShape>,
  ): Layer.Layer<DeployAction> =>
    Layer.succeed(DeployAction, DeployAction.buildTestService(shape))
}
