import {
  Array,
  Context,
  Effect,
  Layer,
  Option,
  Order,
  Record,
  Schema,
  pipe,
} from 'effect'

import type { ActionInputsShape } from '#action-inputs.config.ts'
import { ActionInputs } from '#action-inputs.config.ts'
import type { ComposeFile } from '#compose/compose-file.ts'
import type {
  DesiredDomain,
  DuplicateDomainError,
  UnknownComposeServiceError,
} from '#domains/desired-domains.ts'
import {
  desiredDomains,
  routesWithAllowedMethods,
} from '#domains/desired-domains.ts'
import type { DomainDiff } from '#domains/domain-diff.ts'
import { diffDomains } from '#domains/domain-diff.ts'
import type {
  DokployClientShape,
  DokployError,
} from '#dokploy/dokploy-client.ts'
import { DokployClient } from '#dokploy/dokploy-client.ts'
import type {
  DokployNames,
  DokployTarget,
  DokployTargetError,
  VaultProviderError,
} from '#dokploy/dokploy-target.ts'
import { findVaultProvider, resolveTarget } from '#dokploy/dokploy-target.ts'
import { EffectService } from '#effect/index.ts'
import type {
  InvalidSecretKeyError,
  MissingComposeVariablesError,
  NoSecretKeysError,
  ReferenceGuardError,
} from '#env/env-references.ts'
import {
  checkComposeVariables,
  defaultProviderName,
  guardFolder,
  renderEnvironment,
} from '#env/env-references.ts'
import type { EnvDiff } from '#env/env-diff.ts'
import { diffEnv } from '#env/env-diff.ts'
import type { Manifest, ManifestEnvironment } from '#manifest/manifest.ts'
import type {
  WorkspaceFileError,
  WorkspaceFilesShape,
} from '#workspace-files.ts'
import { WorkspaceFiles } from '#workspace-files.ts'

export class UnknownEnvironmentError extends Schema.TaggedError<UnknownEnvironmentError>()(
  'UnknownEnvironmentError',
  {
    environment: Schema.String,
    declared: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {
  static notDeclared({
    environment,
    declared,
  }: {
    readonly environment: string
    readonly declared: ReadonlyArray<string>
  }): UnknownEnvironmentError {
    return new UnknownEnvironmentError({
      environment,
      declared,
      message: `the manifest declares no environment ${environment} (declared: ${declared.join(', ')})`,
    })
  }
}

export interface DeploymentPlan {
  readonly environment: string
  readonly dokploy: DokployNames & DokployTarget
  readonly provider: string
  readonly folder: string
  readonly keys: ReadonlyArray<string>
  readonly env: string
  readonly domains: ReadonlyArray<DesiredDomain>
  readonly changes: DeploymentChanges
  readonly unsupported: ReadonlyArray<string>
}

export interface DeploymentChanges {
  readonly env: EnvDiff
  readonly domains: DomainDiff
}

export type DeploymentPlanError =
  | WorkspaceFileError
  | UnknownEnvironmentError
  | ReferenceGuardError
  | UnknownComposeServiceError
  | DuplicateDomainError
  | DokployError
  | DokployTargetError
  | VaultProviderError
  | MissingComposeVariablesError
  | InvalidSecretKeyError
  | NoSecretKeysError

export interface DeploymentPlannerShape {
  readonly plan: Effect.Effect<DeploymentPlan, DeploymentPlanError>
}

interface DeploymentPlannerDependencies {
  readonly inputs: ActionInputsShape
  readonly workspaceFiles: WorkspaceFilesShape
  readonly dokploy: DokployClientShape
}

interface SelectedEnvironment {
  readonly manifest: Manifest
  readonly environment: ManifestEnvironment
}

function selectEnvironment({
  manifest,
  name,
}: {
  readonly manifest: Manifest
  readonly name: string
}) {
  return pipe(
    Record.get(manifest.environments, name),
    Option.map((environment): SelectedEnvironment => ({
      manifest,
      environment,
    })),
    Effect.fromOption(() =>
      UnknownEnvironmentError.notDeclared({
        environment: name,
        declared: Record.keys(manifest.environments),
      }),
    ),
    Effect.withSpan('DeploymentPlanner.selectEnvironment', {
      attributes: { environment: name },
    }),
  )
}

interface ResolvedEnvironment extends SelectedEnvironment {
  readonly compose: ComposeFile
  readonly domains: ReadonlyArray<DesiredDomain>
  readonly target: DokployTarget
}

function providerOf({ dokploy, secrets }: ManifestEnvironment): string {
  return secrets?.provider ?? defaultProviderName(dokploy)
}

class ManifestDeploymentPlanner implements DeploymentPlannerShape {
  readonly plan: Effect.Effect<DeploymentPlan, DeploymentPlanError>

  private readonly dependencies: DeploymentPlannerDependencies

  private constructor(dependencies: DeploymentPlannerDependencies) {
    this.dependencies = dependencies
    this.plan = this.buildPlan()
  }

  static make(
    dependencies: DeploymentPlannerDependencies,
  ): ManifestDeploymentPlanner {
    return new ManifestDeploymentPlanner(dependencies)
  }

  private buildPlan() {
    const { inputs, workspaceFiles } = this.dependencies
    return pipe(
      workspaceFiles.readManifest(inputs.manifest),
      Effect.flatMap((manifest) =>
        selectEnvironment({ manifest, name: inputs.environment }),
      ),
      Effect.tap(({ manifest, environment }) =>
        guardFolder({
          folder: manifest.secrets.folder,
          project: environment.dokploy.project,
        }),
      ),
      Effect.flatMap((selected) => this.planEnvironment(selected)),
      Effect.withSpan('DeploymentPlanner.plan', {
        attributes: {
          manifest: inputs.manifest,
          environment: inputs.environment,
        },
      }),
    )
  }

  private planEnvironment({ manifest, environment }: SelectedEnvironment) {
    const { workspaceFiles } = this.dependencies
    return pipe(
      workspaceFiles.readCompose(manifest.composeFile),
      Effect.flatMap((compose) =>
        Effect.all({
          compose: Effect.succeed(compose),
          domains: desiredDomains({
            domains: manifest.domains,
            parentDomain: environment.domain,
            compose: manifest.composeFile,
            services: compose.services,
          }),
          target: this.resolveTarget(environment.dokploy),
        }),
      ),
      Effect.flatMap((resolved) =>
        this.planKeys({ manifest, environment, ...resolved }),
      ),
      Effect.withSpan('DeploymentPlanner.planEnvironment'),
    )
  }

  private planKeys(context: ResolvedEnvironment) {
    const { manifest, compose } = context
    return pipe(
      this.listKeys(context),
      Effect.flatMap((keys) => this.renderPlan({ ...context, keys })),
      Effect.tap(({ keys }) =>
        checkComposeVariables({
          keys,
          compose: manifest.composeFile,
          requiredVariables: compose.requiredVariables,
        }),
      ),
      Effect.withSpan('DeploymentPlanner.planKeys'),
    )
  }

  private renderPlan({
    manifest,
    environment,
    domains,
    target,
    keys,
  }: ResolvedEnvironment & { readonly keys: ReadonlyArray<string> }) {
    const provider = providerOf(environment)
    const { folder } = manifest.secrets
    return pipe(
      renderEnvironment({ provider, folder, keys }),
      Effect.flatMap((env) =>
        Effect.all({
          env: Effect.succeed(env),
          changes: this.changesAgainst({ target, env, domains }),
        }),
      ),
      Effect.map(({ env, changes }): DeploymentPlan => ({
        provider,
        folder,
        keys,
        env,
        domains,
        changes,
        unsupported: routesWithAllowedMethods(domains),
        environment: this.dependencies.inputs.environment,
        dokploy: { ...environment.dokploy, ...target },
      })),
      Effect.withSpan('DeploymentPlanner.renderPlan'),
    )
  }

  private changesAgainst({
    target,
    env,
    domains,
  }: {
    readonly target: DokployTarget
    readonly env: string
    readonly domains: ReadonlyArray<DesiredDomain>
  }) {
    const { dokploy } = this.dependencies
    return pipe(
      Effect.all(
        {
          currentEnv: dokploy.composeEnv(target.composeId),
          currentDomains: dokploy.composeDomains(target.composeId),
        },
        { concurrency: 'unbounded' },
      ),
      Effect.map(({ currentEnv, currentDomains }): DeploymentChanges => ({
        env: diffEnv({ current: currentEnv, desired: env }),
        domains: diffDomains({ current: currentDomains, desired: domains }),
      })),
      Effect.withSpan('DeploymentPlanner.changesAgainst', {
        attributes: { composeId: target.composeId },
      }),
    )
  }

  private resolveTarget(names: DokployNames) {
    return pipe(
      this.dependencies.dokploy.projects,
      Effect.flatMap((projects) => resolveTarget({ projects, names })),
      Effect.withSpan('DeploymentPlanner.resolveTarget'),
    )
  }

  private listKeys({
    manifest,
    environment,
    target,
  }: SelectedEnvironment & { readonly target: DokployTarget }) {
    const { dokploy } = this.dependencies
    return pipe(
      dokploy.vaultProviders,
      Effect.flatMap((providers) =>
        findVaultProvider({
          providers,
          name: providerOf(environment),
          folder: manifest.secrets.folder,
        }),
      ),
      Effect.flatMap(({ vaultProviderId }) =>
        dokploy.listSecretNames({
          vaultProviderId,
          projectId: target.projectId,
          environmentId: target.environmentId,
        }),
      ),
      Effect.map((keys) => pipe(keys, Array.dedupe, Array.sort(Order.String))),
      Effect.withSpan('DeploymentPlanner.listKeys'),
    )
  }
}

export class DeploymentPlanner extends Context.Service<
  DeploymentPlanner,
  DeploymentPlannerShape
>()('dokploy-deploy/DeploymentPlanner') {
  static readonly layer = Layer.effect(
    DeploymentPlanner,
    Effect.map(
      EffectService.all({
        inputs: ActionInputs,
        workspaceFiles: WorkspaceFiles,
        dokploy: DokployClient,
      }),
      (dependencies) => ManifestDeploymentPlanner.make(dependencies),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<DeploymentPlannerShape> = {},
  ) =>
    DeploymentPlanner.of({
      plan: Effect.succeed({
        environment: 'production',
        dokploy: {
          project: 'demo',
          environment: 'production',
          compose: 'demo',
          projectId: 'test-project-id',
          environmentId: 'test-environment-id',
          composeId: 'test-compose-id',
        },
        provider: 'demo-prod',
        folder: '/demo',
        keys: ['MESSAGE'],
        env: "MESSAGE='${{vault.demo-prod./demo:MESSAGE}}'\n",
        domains: [],
        changes: {
          env: { drift: false, added: [], removed: [], changed: [] },
          domains: { create: [], update: [], delete: [], unchanged: [] },
        },
        unsupported: [],
      }),
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    DeploymentPlanner,
    DeploymentPlanner.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<DeploymentPlannerShape>,
  ): Layer.Layer<DeploymentPlanner> =>
    Layer.succeed(DeploymentPlanner, DeploymentPlanner.buildTestService(shape))
}
