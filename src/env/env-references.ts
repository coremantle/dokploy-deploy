import { Array, Effect, Option, Order, Schema, pipe } from 'effect'

import type { EnvLine, PlainEntry } from '#env/plain-values.ts'
import { checkPlainKeys, plainLine, sortedBlock } from '#env/plain-values.ts'

const dotenvKey = /^[A-Za-z0-9_.-]+$/u

const sharedFolder = '/shared'

export class InvalidSecretKeyError extends Schema.TaggedError<InvalidSecretKeyError>()(
  'InvalidSecretKeyError',
  { keys: Schema.Array(Schema.String), message: Schema.String },
) {
  static forKeys(keys: ReadonlyArray<string>): InvalidSecretKeyError {
    return new InvalidSecretKeyError({
      keys,
      message: `secret key(s) ${keys.join(', ')} cannot be written as a Dokploy reference: a key name holds only letters, digits, '_', '.' and '-'`,
    })
  }
}

export class NoSecretKeysError extends Schema.TaggedError<NoSecretKeysError>()(
  'NoSecretKeysError',
  { provider: Schema.String, folder: Schema.String, message: Schema.String },
) {
  static forFolder({ provider, folder }: ReferenceSource): NoSecretKeysError {
    return new NoSecretKeysError({
      provider,
      folder,
      message: `vault provider ${provider} lists no secret key in ${folder}: check that the provider reads that folder`,
    })
  }
}

export class ReferenceGuardError extends Schema.TaggedError<ReferenceGuardError>()(
  'ReferenceGuardError',
  { folder: Schema.String, project: Schema.String, message: Schema.String },
) {
  static outside({ folder, project }: GuardedFolder): ReferenceGuardError {
    return new ReferenceGuardError({
      folder,
      project,
      message: `secrets folder ${folder} is outside ${allowedRoots(project).join(' and ')}, the only folders the references of Dokploy project ${project} may point to`,
    })
  }
}

export class MissingComposeVariablesError extends Schema.TaggedError<MissingComposeVariablesError>()(
  'MissingComposeVariablesError',
  {
    compose: Schema.String,
    variables: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {
  static forVariables({
    compose,
    variables,
  }: {
    readonly compose: string
    readonly variables: ReadonlyArray<string>
  }): MissingComposeVariablesError {
    return new MissingComposeVariablesError({
      compose,
      variables,
      message: `${compose} uses ${variables.join(', ')} without a default, but the secrets folder has no such key: the Dokploy deploy would fail`,
    })
  }
}

export class VersionWithoutCommitError extends Schema.TaggedError<VersionWithoutCommitError>()(
  'VersionWithoutCommitError',
  { key: Schema.String, message: Schema.String },
) {
  static forKey(key: string): VersionWithoutCommitError {
    return new VersionWithoutCommitError({
      key,
      message: `version-env ${key} writes the commit being deployed, but the commit input is empty: pass the commit, or leave version-env empty`,
    })
  }
}

export class VersionKeyCollisionError extends Schema.TaggedError<VersionKeyCollisionError>()(
  'VersionKeyCollisionError',
  {
    key: Schema.String,
    provider: Schema.String,
    folder: Schema.String,
    message: Schema.String,
  },
) {
  static forKey({
    key,
    provider,
    folder,
  }: ReferenceSource & { readonly key: string }): VersionKeyCollisionError {
    return new VersionKeyCollisionError({
      key,
      provider,
      folder,
      message: `version-env ${key} is also a secret key that vault provider ${provider} lists in ${folder}: the action writes ${key} itself, so rename the secret or pick another version-env`,
    })
  }
}

export interface ReferenceSource {
  readonly provider: string
  readonly folder: string
}

export interface GuardedFolder {
  readonly folder: string
  readonly project: string
}

export interface AppVersion {
  readonly key: string
  readonly value: string
}

export const versionLength = 12

const defaultProviderEnvironment = 'production'

const providerNameLength = 64

export function dokploySlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
}

export function defaultProviderName({
  project,
  environment,
}: {
  readonly project: string
  readonly environment: string
}): string {
  const suffix =
    environment === defaultProviderEnvironment
      ? ''
      : `-${dokploySlug(environment)}`
  return `infisical-${dokploySlug(project)}${suffix}`.slice(
    0,
    providerNameLength,
  )
}

function allowedRoots(project: string): ReadonlyArray<string> {
  const slug = dokploySlug(project)
  return slug === '' ? [sharedFolder] : [`/${slug}`, sharedFolder]
}

function isUnder({
  root,
  folder,
}: {
  readonly root: string
  readonly folder: string
}) {
  return folder === root || folder.startsWith(`${root}/`)
}

export function guardFolder(target: GuardedFolder) {
  return pipe(
    allowedRoots(target.project),
    Array.some((root) => isUnder({ root, folder: target.folder })),
    (allowed) =>
      allowed ? Effect.void : Effect.fail(ReferenceGuardError.outside(target)),
    Effect.withSpan('EnvReferences.guardFolder'),
  )
}

function referenceLine({
  provider,
  folder,
  key,
}: ReferenceSource & { readonly key: string }): EnvLine {
  return { key, line: `${key}='\${{vault.${provider}.${folder}:${key}}}'\n` }
}

export function renderEnvironment({
  keys,
  version = Option.none(),
  plain = [],
  ...source
}: ReferenceSource & {
  readonly keys: ReadonlyArray<string>
  readonly version?: Option.Option<AppVersion>
  readonly plain?: ReadonlyArray<PlainEntry>
}) {
  const sortedKeys = pipe(keys, Array.dedupe, Array.sort(Order.String))
  const invalidKeys = Array.filter(sortedKeys, (key) => !dotenvKey.test(key))
  const collision = Option.filter(version, ({ key }) =>
    Array.contains(sortedKeys, key),
  )
  return pipe(
    Effect.succeed(sortedKeys),
    Effect.filterOrFail(Array.isReadonlyArrayNonEmpty, () =>
      NoSecretKeysError.forFolder(source),
    ),
    Effect.filterOrFail(
      () => Array.isReadonlyArrayEmpty(invalidKeys),
      () => InvalidSecretKeyError.forKeys(invalidKeys),
    ),
    Effect.flatMap((validKeys) =>
      Option.match(collision, {
        onNone: () => Effect.succeed(validKeys),
        onSome: ({ key }) =>
          Effect.fail(VersionKeyCollisionError.forKey({ ...source, key })),
      }),
    ),
    Effect.tap((validKeys) =>
      checkPlainKeys({ plain, version, secretKeys: validKeys }),
    ),
    Effect.map((validKeys) =>
      [
        sortedBlock([
          ...Array.map(validKeys, (key) => referenceLine({ ...source, key })),
          ...Array.map(plain, plainLine),
        ]),
        ...Option.toArray(Option.map(version, versionLine)),
      ].join(''),
    ),
    Effect.withSpan('EnvReferences.renderEnvironment', {
      attributes: { provider: source.provider, folder: source.folder },
    }),
  )
}

export function checkComposeVariables({
  compose,
  requiredVariables,
  keys,
}: {
  readonly compose: string
  readonly requiredVariables: ReadonlyArray<string>
  readonly keys: ReadonlyArray<string>
}) {
  const missing = Array.difference(requiredVariables, keys)
  return pipe(
    Array.isReadonlyArrayNonEmpty(missing)
      ? Effect.fail(
          MissingComposeVariablesError.forVariables({
            compose,
            variables: missing,
          }),
        )
      : Effect.void,
    Effect.withSpan('EnvReferences.checkComposeVariables', {
      attributes: { compose },
    }),
  )
}

export function resolveVersion({
  variable,
  commit,
}: {
  readonly variable: Option.Option<string>
  readonly commit: Option.Option<string>
}) {
  return pipe(
    variable,
    Option.match({
      onNone: () => Effect.succeedNone,
      onSome: (key) =>
        pipe(
          commit,
          Effect.fromOption(() => VersionWithoutCommitError.forKey(key)),
          Effect.map((sha) =>
            Option.some<AppVersion>({
              key,
              value: sha.toLowerCase().slice(0, versionLength),
            }),
          ),
        ),
    }),
    Effect.withSpan('EnvReferences.resolveVersion'),
  )
}

export function versionLine({ key, value }: AppVersion): string {
  return `${key}=${value}\n`
}
