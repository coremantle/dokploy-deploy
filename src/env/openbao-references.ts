import { Array, Effect, Option, Order, Record, Schema, pipe } from 'effect'

import type { AppVersion } from '#env/env-references.ts'
import { dokploySlug, versionLine } from '#env/env-references.ts'
import type { OpenBaoSecrets } from '#manifest/manifest.ts'
import { openBaoReference } from '#manifest/manifest.ts'

const sharedMount = 'shared'

export const dokployListingLimit = 200

const wholeReference = new RegExp(`^(${openBaoReference})$`, 'u')

const embeddedReference = new RegExp(
  String.raw`\$\{(${openBaoReference})\}`,
  'u',
)

export interface OpenBaoReference {
  readonly provider: string
  readonly path: string
  readonly field: string
}

export type OpenBaoPart =
  | { readonly kind: 'literal'; readonly text: string }
  | {
      readonly kind: 'reference'
      readonly path: string
      readonly field: string
    }

export interface OpenBaoEntry {
  readonly key: string
  readonly provider: string
  readonly parts: ReadonlyArray<OpenBaoPart>
}

export interface OpenBaoMount {
  readonly provider: string
  readonly mount: string
  readonly namespace: Option.Option<string>
}

export class DuplicateSecretKeyError extends Schema.TaggedError<DuplicateSecretKeyError>()(
  'DuplicateSecretKeyError',
  { keys: Schema.Array(Schema.String), message: Schema.String },
) {
  static forKeys(keys: ReadonlyArray<string>): DuplicateSecretKeyError {
    return new DuplicateSecretKeyError({
      keys,
      message: `environment key(s) ${keys.join(', ')} are mapped by several OpenBao providers of the manifest: map each key once`,
    })
  }
}

export class MountGuardError extends Schema.TaggedError<MountGuardError>()(
  'MountGuardError',
  {
    provider: Schema.String,
    mount: Schema.String,
    project: Schema.String,
    message: Schema.String,
  },
) {
  static outside({
    provider,
    mount,
    project,
  }: {
    readonly provider: string
    readonly mount: string
    readonly project: string
  }): MountGuardError {
    return new MountGuardError({
      provider,
      mount,
      project,
      message: `vault provider ${provider} reads the OpenBao mount ${mount}, outside ${allowedMounts(project).join(' and ')}, the only mounts the references of Dokploy project ${project} may point to`,
    })
  }
}

export class MissingSecretReferencesError extends Schema.TaggedError<MissingSecretReferencesError>()(
  'MissingSecretReferencesError',
  {
    provider: Schema.String,
    references: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {
  static forReferences({
    provider,
    references,
    listed,
  }: {
    readonly provider: string
    readonly references: ReadonlyArray<string>
    readonly listed: number
  }): MissingSecretReferencesError {
    const hint =
      listed === 0
        ? `; it lists nothing at all: check that its token may list the mount's metadata`
        : ''
    return new MissingSecretReferencesError({
      provider,
      references,
      message: `vault provider ${provider} lists no ${references.join(', ')} (path:field, relative to its mount): the Dokploy deploy would fail${hint}`,
    })
  }
}

export class VersionKeyMappedError extends Schema.TaggedError<VersionKeyMappedError>()(
  'VersionKeyMappedError',
  { key: Schema.String, message: Schema.String },
) {
  static forKey(key: string): VersionKeyMappedError {
    return new VersionKeyMappedError({
      key,
      message: `version-env ${key} is also a key of the manifest's OpenBao mapping: the action writes ${key} itself, so rename the key or pick another version-env`,
    })
  }
}

export function referenceName({
  path,
  field,
}: Pick<OpenBaoReference, 'path' | 'field'>): string {
  return `${path}:${field}`
}

function splitReference(reference: string) {
  const separator = reference.lastIndexOf(':')
  return {
    path: reference.slice(0, separator),
    field: reference.slice(separator + 1),
  }
}

export function parseOpenBaoValue(value: string): ReadonlyArray<OpenBaoPart> {
  return wholeReference.test(value)
    ? [{ kind: 'reference', ...splitReference(value) }]
    : pipe(
        value.split(embeddedReference),
        Array.flatMap((text, index): ReadonlyArray<OpenBaoPart> => {
          if (index % 2 === 1) {
            return [{ kind: 'reference', ...splitReference(text) }]
          }
          return text === '' ? [] : [{ text, kind: 'literal' }]
        }),
      )
}

export function openBaoEntries({ openbao }: OpenBaoSecrets) {
  const entries = pipe(
    Record.toEntries(openbao),
    Array.flatMap(([provider, env]) =>
      Array.map(Record.toEntries(env), ([key, value]): OpenBaoEntry => ({
        key,
        provider,
        parts: parseOpenBaoValue(value),
      })),
    ),
    Array.sort(Order.mapInput(Order.String, ({ key }: OpenBaoEntry) => key)),
  )
  const keys = Array.map(entries, ({ key }) => key)
  const duplicates = pipe(
    keys,
    Array.filter((key, index) => keys.indexOf(key) !== index),
    Array.dedupe,
  )
  return pipe(
    Array.isReadonlyArrayEmpty(duplicates)
      ? Effect.succeed(entries)
      : Effect.fail(DuplicateSecretKeyError.forKeys(duplicates)),
    Effect.withSpan('OpenBaoReferences.entries'),
  )
}

export function referencesOf(
  entries: ReadonlyArray<OpenBaoEntry>,
): ReadonlyArray<OpenBaoReference> {
  return pipe(
    entries,
    Array.flatMap(({ provider, parts }) =>
      Array.flatMap(parts, (part): ReadonlyArray<OpenBaoReference> =>
        part.kind === 'reference'
          ? [{ provider, path: part.path, field: part.field }]
          : [],
      ),
    ),
    Array.dedupeWith(
      (left, right) =>
        left.provider === right.provider &&
        left.path === right.path &&
        left.field === right.field,
    ),
  )
}

function allowedMounts(project: string): ReadonlyArray<string> {
  const slug = dokploySlug(project)
  return slug === '' ? [sharedMount] : [slug, sharedMount]
}

export function guardMount({
  provider,
  mount,
  project,
}: {
  readonly provider: string
  readonly mount: string
  readonly project: string
}) {
  return pipe(
    Array.contains(allowedMounts(project), mount)
      ? Effect.void
      : Effect.fail(MountGuardError.outside({ provider, mount, project })),
    Effect.withSpan('OpenBaoReferences.guardMount', {
      attributes: { provider, mount },
    }),
  )
}

export interface ListedReferences {
  readonly missing: ReadonlyArray<string>
  readonly unverified: ReadonlyArray<string>
}

export function checkListedReferences({
  provider,
  references,
  listed,
}: {
  readonly provider: string
  readonly references: ReadonlyArray<OpenBaoReference>
  readonly listed: ReadonlyArray<string>
}) {
  const missing = pipe(
    references,
    Array.filter((reference) => reference.provider === provider),
    Array.map(referenceName),
    Array.filter((name) => !Array.contains(listed, name)),
  )
  const truncated = listed.length >= dokployListingLimit
  return pipe(
    Array.isReadonlyArrayEmpty(missing) || truncated
      ? Effect.succeed(
          truncated ? Array.map(missing, (name) => `${provider}:${name}`) : [],
        )
      : Effect.fail(
          MissingSecretReferencesError.forReferences({
            provider,
            references: missing,
            listed: listed.length,
          }),
        ),
    Effect.withSpan('OpenBaoReferences.checkListedReferences', {
      attributes: { provider, listed: listed.length },
    }),
  )
}

function vaultReference({ provider, path, field }: OpenBaoReference): string {
  return `\${{vault.${provider}.${path}:${field}}}`
}

function entryLine({ key, provider, parts }: OpenBaoEntry): string {
  const value = Array.map(parts, (part) =>
    part.kind === 'literal'
      ? part.text
      : vaultReference({ provider, path: part.path, field: part.field }),
  ).join('')
  return `${key}='${value}'\n`
}

export function renderOpenBaoEnvironment({
  entries,
  version = Option.none(),
}: {
  readonly entries: ReadonlyArray<OpenBaoEntry>
  readonly version?: Option.Option<AppVersion>
}) {
  const collision = Option.filter(version, ({ key }) =>
    Array.some(entries, (entry) => entry.key === key),
  )
  const checked: Effect.Effect<void, VersionKeyMappedError> = Option.match(
    collision,
    {
      onNone: () => Effect.void,
      onSome: ({ key }) => Effect.fail(VersionKeyMappedError.forKey(key)),
    },
  )
  return pipe(
    checked,
    Effect.map(() =>
      [
        ...Array.map(entries, entryLine),
        ...Option.toArray(Option.map(version, versionLine)),
      ].join(''),
    ),
    Effect.withSpan('OpenBaoReferences.renderEnvironment', {
      attributes: { keys: entries.length },
    }),
  )
}
