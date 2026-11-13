import { Array, Effect, Schema, pipe } from 'effect'

import type { DokployProject, VaultProvider } from '#dokploy/dokploy-client.ts'

export interface DokployNames {
  readonly project: string
  readonly environment: string
  readonly compose: string
}

export interface DokployTarget {
  readonly projectId: string
  readonly environmentId: string
  readonly composeId: string
}

export class DokployTargetError extends Schema.TaggedError<DokployTargetError>()(
  'DokployTargetError',
  {
    kind: Schema.Literals(['project', 'environment', 'compose']),
    dokployName: Schema.String,
    message: Schema.String,
  },
) {
  static notFound({
    kind,
    name,
    matches,
  }: NamedLookup & { readonly matches: number }): DokployTargetError {
    return new DokployTargetError({
      kind,
      dokployName: name,
      message:
        matches === 0
          ? `the API key sees no Dokploy ${kind} named ${name}: check the manifest and the key's access`
          : `the API key sees ${matches} Dokploy ${kind}s named ${name}: rename them so the manifest names one`,
    })
  }
}

export class VaultProviderError extends Schema.TaggedError<VaultProviderError>()(
  'VaultProviderError',
  { provider: Schema.String, message: Schema.String },
) {
  static because({
    provider,
    reason,
  }: {
    readonly provider: string
    readonly reason: string
  }): VaultProviderError {
    return new VaultProviderError({
      provider,
      message: `vault provider ${provider} ${reason}`,
    })
  }
}

interface NamedLookup {
  readonly kind: 'project' | 'environment' | 'compose'
  readonly name: string
}

function single<A extends { readonly name: string }>({
  candidates,
  lookup,
}: {
  readonly candidates: ReadonlyArray<A>
  readonly lookup: NamedLookup
}) {
  return pipe(
    Effect.succeed(
      Array.filter(candidates, ({ name }) => name === lookup.name),
    ),
    Effect.filterOrFail(
      (matches): matches is [A] => matches.length === 1,
      (matches) =>
        DokployTargetError.notFound({ ...lookup, matches: matches.length }),
    ),
    Effect.map(([match]) => match),
    Effect.withSpan('DokployTarget.single', {
      attributes: { kind: lookup.kind },
    }),
  )
}

type DokployEnvironment = DokployProject['environments'][number]

function resolveCompose({
  project,
  environment,
  names,
}: {
  readonly project: DokployProject
  readonly environment: DokployEnvironment
  readonly names: DokployNames
}) {
  return pipe(
    single({
      candidates: environment.compose,
      lookup: { kind: 'compose', name: names.compose },
    }),
    Effect.map(({ composeId }): DokployTarget => ({
      composeId,
      projectId: project.projectId,
      environmentId: environment.environmentId,
    })),
    Effect.withSpan('DokployTarget.resolveCompose'),
  )
}

function resolveEnvironment({
  project,
  names,
}: {
  readonly project: DokployProject
  readonly names: DokployNames
}) {
  return pipe(
    single({
      candidates: project.environments,
      lookup: { kind: 'environment', name: names.environment },
    }),
    Effect.flatMap((environment) =>
      resolveCompose({ project, environment, names }),
    ),
    Effect.withSpan('DokployTarget.resolveEnvironment'),
  )
}

export function resolveTarget({
  projects,
  names,
}: {
  readonly projects: ReadonlyArray<DokployProject>
  readonly names: DokployNames
}) {
  return pipe(
    single({
      candidates: projects,
      lookup: { kind: 'project', name: names.project },
    }),
    Effect.flatMap((project) => resolveEnvironment({ project, names })),
    Effect.withSpan('DokployTarget.resolveTarget'),
  )
}

function withoutTrailingSlash(path: string) {
  return path.length > 1 ? path.replace(/\/+$/u, '') : path
}

export function findVaultProvider({
  providers,
  name,
  folder,
}: {
  readonly providers: ReadonlyArray<VaultProvider>
  readonly name: string
  readonly folder: string
}) {
  return pipe(
    Array.findFirst(providers, (provider) => provider.name === name),
    Effect.fromOption(() =>
      VaultProviderError.because({
        provider: name,
        reason:
          'is not visible to the API key: check its name and its assignment to the project',
      }),
    ),
    Effect.filterOrFail(
      ({ providerType }) => providerType === 'infisical',
      ({ providerType }) =>
        VaultProviderError.because({
          provider: name,
          reason: `is a ${providerType} provider; the action only supports Infisical`,
        }),
    ),
    Effect.filterOrFail(
      ({ config }) => withoutTrailingSlash(config.secretPath ?? '/') === folder,
      ({ config }) =>
        VaultProviderError.because({
          provider: name,
          reason: `reads ${config.secretPath ?? '/'}, not the manifest's secrets folder ${folder}: its key list would not match the references`,
        }),
    ),
    Effect.withSpan('DokployTarget.findVaultProvider', {
      attributes: { provider: name },
    }),
  )
}
