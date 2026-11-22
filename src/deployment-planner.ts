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
import type { ComposeFile, RouterHost } from '#compose/compose-file.ts'
import type {
  DesiredDomain,
  DuplicateDomainError,
  UnknownComposeServiceError,
} from '#domains/desired-domains.ts'
import {
  desiredDomains,
  manifestHosts,
  routesWithAllowedMethods,
  strayRouterHosts,
} from '#domains/desired-domains.ts'
import type { DomainDiff } from '#domains/domain-diff.ts'
import { diffDomains } from '#domains/domain-diff.ts'
import type {
  DokployClientShape,
  DokployError,
  VaultProvider,
} from '#dokploy/dokploy-client.ts'
import { DokployClient } from '#dokploy/dokploy-client.ts'
import type {
  DokployNames,
  DokployTarget,
  DokployTargetError,
  OpenBaoProvider,
  VaultProviderError,
} from '#dokploy/dokploy-target.ts'
import {
  findOpenBaoProvider,
  findVaultProvider,
  resolveTarget,
} from '#dokploy/dokploy-target.ts'
import { EffectService } from '#effect/index.ts'
import type {
  AppVersion,
  InvalidSecretKeyError,
  MissingComposeVariablesError,
  NoSecretKeysError,
  ReferenceGuardError,
  VersionKeyCollisionError,
  VersionWithoutCommitError,
} from '#env/env-references.ts'
import {
  checkComposeVariables,
  defaultProviderName,
  guardFolder,
  renderEnvironment,
  resolveVersion,
} from '#env/env-references.ts'
import type { EnvDiff } from '#env/env-diff.ts'
import { diffEnv } from '#env/env-diff.ts'
import type {
  DuplicateSecretKeyError,
  MissingSecretReferencesError,
  MountGuardError,
  OpenBaoEntry,
  OpenBaoReference,
  VersionKeyMappedError,
} from '#env/openbao-references.ts'
import {
  checkListedReferences,
  guardMount,
  openBaoEntries,
  referenceName,
  referencesOf,
  renderOpenBaoEnvironment,
} from '#env/openbao-references.ts'
import type { PlainValueCollisionError } from '#env/plain-values.ts'
import { checkPlainKeys, plainEntries } from '#env/plain-values.ts'
import type {
  Manifest,
  ManifestEnvironment,
  OpenBaoSecrets,
} from '#manifest/manifest.ts'
import { isOpenBao } from '#manifest/manifest.ts'
import type {
  OpenBaoMetadataShape,
  OpenBaoRequestError,
  SecretState,
} from '#openbao/openbao-metadata.ts'
import { OpenBaoMetadata, secretLocation } from '#openbao/openbao-metadata.ts'
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

export class OpenBaoSecretStateError extends Schema.TaggedError<OpenBaoSecretStateError>()(
  'OpenBaoSecretStateError',
  { secrets: Schema.Array(Schema.String), message: Schema.String },
) {
  static forSecrets(
    secrets: ReadonlyArray<{
      readonly location: string
      readonly state: SecretState
    }>,
  ): OpenBaoSecretStateError {
    const lines = Array.map(
      secrets,
      ({ location, state }) => `${location} (${state})`,
    )
    return new OpenBaoSecretStateError({
      secrets: lines,
      message: `OpenBao holds no live version of ${lines.join(', ')}: the Dokploy deploy would fail`,
    })
  }
}

export interface OpenBaoProviderPlan {
  readonly name: string
  readonly mount: string
  readonly references: ReadonlyArray<string>
}

export type SecretsPlan =
  | {
      readonly kind: 'infisical'
      readonly provider: string
      readonly folder: string
    }
  | {
      readonly kind: 'openbao'
      readonly providers: ReadonlyArray<OpenBaoProviderPlan>
      readonly metadataChecked: boolean
    }

export interface DeploymentPlan {
  readonly environment: string
  readonly dokploy: DokployNames & DokployTarget
  readonly secrets: SecretsPlan
  readonly unverifiedReferences: ReadonlyArray<string>
  readonly keys: ReadonlyArray<string>
  readonly plainKeys: ReadonlyArray<string>
  readonly env: string
  readonly version: Option.Option<AppVersion>
  readonly domains: ReadonlyArray<DesiredDomain>
  readonly changes: DeploymentChanges
  readonly unsupported: ReadonlyArray<string>
  readonly strayRouterHosts: ReadonlyArray<RouterHost>
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
  | VersionWithoutCommitError
  | VersionKeyCollisionError
  | DuplicateSecretKeyError
  | MountGuardError
  | MissingSecretReferencesError
  | VersionKeyMappedError
  | OpenBaoRequestError
  | OpenBaoSecretStateError
  | PlainValueCollisionError

export interface DeploymentPlannerShape {
  readonly plan: Effect.Effect<DeploymentPlan, DeploymentPlanError>
}

interface DeploymentPlannerDependencies {
  readonly inputs: ActionInputsShape
  readonly workspaceFiles: WorkspaceFilesShape
  readonly dokploy: DokployClientShape
  readonly openbao: OpenBaoMetadataShape
}

interface SelectedEnvironment {
  readonly manifest: Manifest
  readonly environment: ManifestEnvironment
  readonly version: Option.Option<AppVersion>
}

function selectEnvironment({
  manifest,
  version,
  name,
}: {
  readonly manifest: Manifest
  readonly version: Option.Option<AppVersion>
  readonly name: string
}) {
  return pipe(
    Record.get(manifest.environments, name),
    Option.map((environment): SelectedEnvironment => ({
      manifest,
      environment,
      version,
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
  readonly source: SecretSource
  readonly compose: ComposeFile
  readonly domains: ReadonlyArray<DesiredDomain>
  readonly target: DokployTarget
}

type SecretSource =
  | {
      readonly kind: 'infisical'
      readonly provider: string
      readonly folder: string
    }
  | { readonly kind: 'openbao'; readonly secrets: OpenBaoSecrets }

function infisicalProviderOf({
  dokploy,
  secrets,
}: ManifestEnvironment): string {
  return secrets !== undefined && 'provider' in secrets
    ? secrets.provider
    : defaultProviderName(dokploy)
}

function infisicalSourceOf({
  manifest,
  environment,
}: Pick<SelectedEnvironment, 'manifest' | 'environment'>) {
  return pipe(
    Option.fromUndefinedOr(manifest.secrets),
    // Defect: the manifest schema refuses an Infisical environment without the top-level secrets.folder.
    Effect.fromOption(() => 'an Infisical environment needs secrets.folder'),
    Effect.orDie,
    Effect.map(({ folder }): SecretSource => ({
      folder,
      kind: 'infisical',
      provider: infisicalProviderOf(environment),
    })),
    Effect.withSpan('DeploymentPlanner.infisicalSource'),
  )
}

function secretSourceOf(
  selected: Pick<SelectedEnvironment, 'manifest' | 'environment'>,
) {
  const { environment } = selected
  const source: Effect.Effect<SecretSource> = isOpenBao(environment)
    ? Effect.succeed({ kind: 'openbao', secrets: environment.secrets })
    : infisicalSourceOf(selected)
  return pipe(source, Effect.withSpan('DeploymentPlanner.secretSource'))
}

function guardSource({
  source,
  project,
}: {
  readonly source: SecretSource
  readonly project: string
}) {
  return pipe(
    source.kind === 'infisical'
      ? guardFolder({ project, folder: source.folder })
      : Effect.void,
    Effect.withSpan('DeploymentPlanner.guardSource', {
      attributes: { kind: source.kind },
    }),
  )
}

function resolveOpenBaoProvider({
  providers,
  name,
  project,
}: {
  readonly providers: ReadonlyArray<VaultProvider>
  readonly name: string
  readonly project: string
}) {
  return pipe(
    findOpenBaoProvider({ providers, name }),
    Effect.tap(({ mount }) => guardMount({ mount, project, provider: name })),
    Effect.withSpan('DeploymentPlanner.resolveOpenBaoProvider', {
      attributes: { provider: name },
    }),
  )
}

interface RenderedSecrets {
  readonly secrets: SecretsPlan
  readonly keys: ReadonlyArray<string>
  readonly plainKeys: ReadonlyArray<string>
  readonly env: string
  readonly unverifiedReferences: ReadonlyArray<string>
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
      // Why: version-env without a commit is an input mistake — fail before reading the workspace or calling Dokploy.
      Effect.all({
        version: resolveVersion({
          variable: inputs.versionEnv,
          commit: inputs.commit,
        }),
        manifest: workspaceFiles.readManifest(inputs.manifest),
      }),
      Effect.flatMap(({ manifest, version }) =>
        selectEnvironment({ manifest, version, name: inputs.environment }),
      ),
      Effect.flatMap((selected) => this.planSelected(selected)),
      Effect.withSpan('DeploymentPlanner.plan', {
        attributes: {
          manifest: inputs.manifest,
          environment: inputs.environment,
        },
      }),
    )
  }

  private planSelected(selected: SelectedEnvironment) {
    return pipe(
      secretSourceOf(selected),
      Effect.tap((source) =>
        guardSource({ source, project: selected.environment.dokploy.project }),
      ),
      Effect.flatMap((source) => this.planEnvironment({ ...selected, source })),
      Effect.withSpan('DeploymentPlanner.planSelected'),
    )
  }

  private planEnvironment({
    manifest,
    environment,
    version,
    source,
  }: SelectedEnvironment & { readonly source: SecretSource }) {
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
        this.planKeys({ manifest, environment, version, source, ...resolved }),
      ),
      Effect.withSpan('DeploymentPlanner.planEnvironment'),
    )
  }

  private planKeys(context: ResolvedEnvironment) {
    const { manifest, compose } = context
    return pipe(
      this.renderSecrets(context),
      Effect.tap(({ keys }) =>
        checkComposeVariables({
          keys: [
            ...keys,
            ...Option.toArray(context.version).map(({ key }) => key),
          ],
          compose: manifest.composeFile,
          requiredVariables: compose.requiredVariables,
        }),
      ),
      Effect.flatMap((rendered) => this.renderPlan({ ...context, rendered })),
      Effect.withSpan('DeploymentPlanner.planKeys'),
    )
  }

  private renderSecrets(context: ResolvedEnvironment) {
    const { source } = context
    const rendered: Effect.Effect<RenderedSecrets, DeploymentPlanError> =
      source.kind === 'infisical'
        ? this.renderInfisical({ ...context, source })
        : this.renderOpenBao({ ...context, secrets: source.secrets })
    return pipe(
      rendered,
      Effect.withSpan('DeploymentPlanner.renderSecrets', {
        attributes: { kind: source.kind },
      }),
    )
  }

  private renderInfisical({
    source,
    target,
    version,
    environment,
  }: ResolvedEnvironment & {
    readonly source: { readonly provider: string; readonly folder: string }
  }) {
    const plain = plainEntries(environment)
    const plainKeys = Array.map(plain, ({ key }) => key)
    return pipe(
      this.listKeys({ source, target }),
      Effect.flatMap((keys) =>
        Effect.all({
          keys: Effect.succeed(keys),
          env: renderEnvironment({ ...source, keys, version, plain }),
        }),
      ),
      Effect.map(({ keys, env }): RenderedSecrets => ({
        env,
        plainKeys,
        keys: [...keys, ...plainKeys],
        secrets: {
          kind: 'infisical',
          provider: source.provider,
          folder: source.folder,
        },
        unverifiedReferences: [],
      })),
      Effect.withSpan('DeploymentPlanner.renderInfisical'),
    )
  }

  private renderOpenBao(
    context: ResolvedEnvironment & { readonly secrets: OpenBaoSecrets },
  ) {
    const plain = plainEntries(context.environment)
    const plainKeys = Array.map(plain, ({ key }) => key)
    return pipe(
      openBaoEntries(context.secrets),
      // Why: a plain key the mapping also holds is a manifest mistake — refuse it before calling Dokploy.
      Effect.tap((entries) =>
        checkPlainKeys({
          plain,
          version: context.version,
          secretKeys: Array.map(entries, ({ key }) => key),
        }),
      ),
      Effect.flatMap((entries) =>
        Effect.all({
          entries: Effect.succeed(entries),
          checked: this.checkOpenBao({ ...context, entries }),
          env: renderOpenBaoEnvironment({
            entries,
            plain,
            version: context.version,
          }),
        }),
      ),
      Effect.map(({ entries, checked, env }): RenderedSecrets => ({
        env,
        plainKeys,
        secrets: {
          kind: 'openbao',
          providers: checked.providers,
          metadataChecked: this.dependencies.openbao.enabled,
        },
        keys: [...Array.map(entries, ({ key }) => key), ...plainKeys],
        unverifiedReferences: checked.unverified,
      })),
      Effect.withSpan('DeploymentPlanner.renderOpenBao'),
    )
  }

  private checkOpenBao({
    environment,
    target,
    entries,
  }: ResolvedEnvironment & { readonly entries: ReadonlyArray<OpenBaoEntry> }) {
    const { dokploy } = this.dependencies
    const references = referencesOf(entries)
    const names = pipe(
      entries,
      Array.map(({ provider }) => provider),
      Array.dedupe,
      Array.sort(Order.String),
    )
    return pipe(
      dokploy.vaultProviders,
      Effect.flatMap((providers) =>
        Effect.forEach(names, (name) =>
          resolveOpenBaoProvider({
            providers,
            name,
            project: environment.dokploy.project,
          }),
        ),
      ),
      Effect.flatMap(
        Effect.forEach((provider) =>
          this.listedReferences({ provider, references, target }),
        ),
      ),
      Effect.tap((checked) =>
        this.checkMetadata({
          references,
          providers: Array.map(checked, ({ provider }) => provider),
        }),
      ),
      Effect.map((checked) => ({
        providers: Array.map(checked, ({ provider }): OpenBaoProviderPlan => ({
          name: provider.name,
          mount: provider.mount,
          references: pipe(
            references,
            Array.filter((reference) => reference.provider === provider.name),
            Array.map(referenceName),
            Array.sort(Order.String),
          ),
        })),
        unverified: Array.flatMap(checked, ({ unverified }) => unverified),
      })),
      Effect.withSpan('DeploymentPlanner.checkOpenBao'),
    )
  }

  private listedReferences({
    provider,
    references,
    target,
  }: {
    readonly provider: OpenBaoProvider
    readonly references: ReadonlyArray<OpenBaoReference>
    readonly target: DokployTarget
  }) {
    return pipe(
      this.dependencies.dokploy.listSecretNames({
        vaultProviderId: provider.vaultProviderId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      }),
      Effect.flatMap((listed) =>
        checkListedReferences({ references, listed, provider: provider.name }),
      ),
      Effect.map((unverified) => ({ provider, unverified })),
      Effect.withSpan('DeploymentPlanner.listedReferences', {
        attributes: { provider: provider.name },
      }),
    )
  }

  private checkMetadata({
    references,
    providers,
  }: {
    readonly references: ReadonlyArray<OpenBaoReference>
    readonly providers: ReadonlyArray<{
      readonly name: string
      readonly mount: string
      readonly namespace: Option.Option<string>
    }>
  }) {
    const { openbao } = this.dependencies
    const secrets = pipe(
      providers,
      Array.flatMap(({ name, mount, namespace }) =>
        pipe(
          references,
          Array.filter(({ provider }) => provider === name),
          Array.map(({ path }) => path),
          Array.dedupe,
          Array.map((path) => ({ mount, namespace, path })),
        ),
      ),
    )
    return pipe(
      openbao.enabled
        ? pipe(
            Effect.forEach(
              secrets,
              (secret) =>
                Effect.map(openbao.secretState(secret), (state) => ({
                  state,
                  location: secretLocation(secret),
                })),
              { concurrency: 4 },
            ),
            Effect.map(Array.filter(({ state }) => state !== 'live')),
            Effect.flatMap((notLive) =>
              Array.isReadonlyArrayEmpty(notLive)
                ? Effect.void
                : Effect.fail(OpenBaoSecretStateError.forSecrets(notLive)),
            ),
          )
        : Effect.void,
      Effect.withSpan('DeploymentPlanner.checkMetadata', {
        attributes: { enabled: openbao.enabled, secrets: secrets.length },
      }),
    )
  }

  private renderPlan({
    manifest,
    environment,
    version,
    compose,
    domains,
    target,
    rendered,
  }: ResolvedEnvironment & { readonly rendered: RenderedSecrets }) {
    const { env } = rendered
    return pipe(
      this.changesAgainst({ target, env, domains }),
      Effect.map((changes): DeploymentPlan => ({
        ...rendered,
        version,
        domains,
        changes,
        unsupported: routesWithAllowedMethods(domains),
        strayRouterHosts: strayRouterHosts({
          routerHosts: compose.routerHosts,
          declaredHosts: manifestHosts(manifest),
        }),
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
    source,
    target,
  }: {
    readonly source: { readonly provider: string; readonly folder: string }
    readonly target: DokployTarget
  }) {
    const { dokploy } = this.dependencies
    return pipe(
      dokploy.vaultProviders,
      Effect.flatMap((providers) =>
        findVaultProvider({
          providers,
          name: source.provider,
          folder: source.folder,
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
        openbao: OpenBaoMetadata,
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
        secrets: { kind: 'infisical', provider: 'demo-prod', folder: '/demo' },
        unverifiedReferences: [],
        keys: ['MESSAGE'],
        plainKeys: [],
        env: "MESSAGE='${{vault.demo-prod./demo:MESSAGE}}'\n",
        version: Option.none(),
        domains: [],
        changes: {
          env: { drift: false, added: [], removed: [], changed: [] },
          domains: { create: [], update: [], delete: [], unchanged: [] },
        },
        unsupported: [],
        strayRouterHosts: [],
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
