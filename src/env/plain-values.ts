import { Array, Effect, Option, Order, Record, Schema, pipe } from 'effect'

import type { AppVersion } from '#env/env-references.ts'
import type { ManifestEnvironment } from '#manifest/manifest.ts'

export interface PlainEntry {
  readonly key: string
  readonly value: string
}

export interface EnvLine {
  readonly key: string
  readonly line: string
}

export class PlainValueCollisionError extends Schema.TaggedError<PlainValueCollisionError>()(
  'PlainValueCollisionError',
  { keys: Schema.Array(Schema.String), message: Schema.String },
) {
  static forSecretKeys(keys: ReadonlyArray<string>): PlainValueCollisionError {
    return new PlainValueCollisionError({
      keys,
      message: `environment key(s) ${keys.join(', ')} are both a plain value (\`env\`) and a secret key of the environment: keep each key in one place`,
    })
  }

  static forVersionKey(key: string): PlainValueCollisionError {
    return new PlainValueCollisionError({
      keys: [key],
      message: `version-env ${key} is also a plain value (\`env\`) of the environment: the action writes ${key} itself, so remove it from \`env\` or pick another version-env`,
    })
  }
}

export function plainEntries({
  env,
}: Pick<ManifestEnvironment, 'env'>): ReadonlyArray<PlainEntry> {
  return pipe(
    Record.toEntries(env ?? {}),
    Array.map(([key, value]): PlainEntry => ({ key, value })),
    Array.sort(Order.mapInput(Order.String, ({ key }: PlainEntry) => key)),
  )
}

export function plainLine({ key, value }: PlainEntry): EnvLine {
  return { key, line: `${key}='${value}'\n` }
}

export function checkPlainKeys({
  plain,
  secretKeys,
  version,
}: {
  readonly plain: ReadonlyArray<PlainEntry>
  readonly secretKeys: ReadonlyArray<string>
  readonly version: Option.Option<AppVersion>
}) {
  const plainKeys = Array.map(plain, ({ key }) => key)
  const shared = Array.intersection(plainKeys, secretKeys)
  const versionKey = Option.filter(version, ({ key }) =>
    Array.contains(plainKeys, key),
  )
  return pipe(
    Array.isReadonlyArrayNonEmpty(shared)
      ? Effect.fail(
          PlainValueCollisionError.forSecretKeys(
            Array.sort(shared, Order.String),
          ),
        )
      : Option.match(versionKey, {
          onNone: () => Effect.void,
          onSome: ({ key }) =>
            Effect.fail(PlainValueCollisionError.forVersionKey(key)),
        }),
    Effect.withSpan('PlainValues.checkKeys', {
      attributes: { plain: plain.length },
    }),
  )
}

export function sortedBlock(lines: ReadonlyArray<EnvLine>): string {
  return pipe(
    lines,
    Array.sort(Order.mapInput(Order.String, ({ key }: EnvLine) => key)),
    Array.map(({ line }) => line),
  ).join('')
}
