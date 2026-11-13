import { Array, Order, Predicate, Record, Schema, pipe } from 'effect'

export interface ComposeFile {
  readonly services: ReadonlyArray<string>
  readonly requiredVariables: ReadonlyArray<string>
}

export const ComposeDocument = Schema.Struct({
  services: Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.isMinProperties(1),
  ),
})

const interpolation =
  /\$\$|\$\{([A-Za-z_]\w*)(?:(:?[-+?])[^}]*)?\}|\$([A-Za-z_]\w*)/gu

const requiringModifiers = new Set([undefined, '?', ':?'])

function scalarStrings(value: unknown): ReadonlyArray<string> {
  if (Predicate.isString(value)) return [value]
  if (Array.isArray(value)) return Array.flatMap(value, scalarStrings)
  if (Predicate.isObject(value)) {
    return Array.flatMap(Record.values(value), scalarStrings)
  }
  return []
}

function requiredIn(text: string): ReadonlyArray<string> {
  return Array.flatMap(
    Array.fromIterable(text.matchAll(interpolation)),
    ([, braced, modifier, bare]) => {
      if (bare !== undefined) return [bare]
      if (braced !== undefined && requiringModifiers.has(modifier)) {
        return [braced]
      }
      return []
    },
  )
}

export function requiredVariables(document: unknown): ReadonlyArray<string> {
  return pipe(
    scalarStrings(document),
    Array.flatMap(requiredIn),
    Array.dedupe,
    Array.sort(Order.String),
  )
}

export function composeFileFrom({
  document,
  decoded,
}: {
  readonly document: unknown
  readonly decoded: typeof ComposeDocument.Type
}): ComposeFile {
  return {
    services: pipe(Record.keys(decoded.services), Array.sort(Order.String)),
    requiredVariables: requiredVariables(document),
  }
}
