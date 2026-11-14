import { Array, Option, Order, Predicate, Record, Schema, pipe } from 'effect'

export interface RouterHost {
  readonly service: string
  readonly router: string
  readonly host: string
}

export interface ComposeFile {
  readonly services: ReadonlyArray<string>
  readonly requiredVariables: ReadonlyArray<string>
  readonly routerHosts: ReadonlyArray<RouterHost>
}

export const ComposeDocument = Schema.Struct({
  services: Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.isMinProperties(1),
  ),
})

const ListLabels = Schema.Array(Schema.Unknown)

const Labels = Schema.Union([
  ListLabels,
  Schema.Record(Schema.String, Schema.Unknown),
])

const LabelsHolder = Schema.Struct({
  labels: Schema.optionalKey(Schema.Unknown),
  deploy: Schema.optionalKey(Schema.Unknown),
})

const routerRuleKey = /^traefik\.http\.routers\.([^.]+)\.rule$/iu

const hostMatcher = /(?<!!\s*)(?<!\w)Host(?:Header)?\s*\(([^)]*)\)/giu

const quotedHost = /`([^`]*)`|"([^"]*)"/gu

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

type Label = readonly [key: string, value: string]

function listLabel(label: string): ReadonlyArray<Label> {
  const separator = label.indexOf('=')
  if (separator === -1) return []
  return [[label.slice(0, separator).trim(), label.slice(separator + 1)]]
}

function labelEntries(labels: typeof Labels.Type): ReadonlyArray<Label> {
  if (Schema.is(ListLabels)(labels)) {
    return pipe(
      labels,
      Array.filter(Predicate.isString),
      Array.flatMap(listLabel),
    )
  }
  return pipe(
    Record.toEntries(labels),
    Array.filter((entry): entry is [string, string] =>
      Predicate.isString(entry[1]),
    ),
  )
}

function holderOf(value: unknown): typeof LabelsHolder.Type {
  return Option.getOrElse(
    Schema.decodeUnknownOption(LabelsHolder)(value),
    () => ({}),
  )
}

function labelsOf(labels: unknown): ReadonlyArray<Label> {
  return pipe(
    Schema.decodeUnknownOption(Labels)(labels),
    Option.match({ onNone: () => [], onSome: labelEntries }),
  )
}

function hostsIn(rule: string): ReadonlyArray<string> {
  return pipe(
    Array.fromIterable(rule.matchAll(hostMatcher)),
    Array.flatMap(([, args = '']) =>
      Array.fromIterable(args.matchAll(quotedHost)),
    ),
    Array.map(([, backticked, doubleQuoted]) =>
      (backticked ?? doubleQuoted ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.$/u, ''),
    ),
    Array.filter((host) => host.length > 0 && !host.includes('$')),
  )
}

function serviceRouterHosts([service, definition]: readonly [
  string,
  unknown,
]): ReadonlyArray<RouterHost> {
  const { labels, deploy } = holderOf(definition)
  return Array.flatMap(
    [...labelsOf(labels), ...labelsOf(holderOf(deploy).labels)],
    ([key, rule]) => {
      const router = routerRuleKey.exec(key)?.[1]
      if (router === undefined) return []
      return Array.map(hostsIn(rule), (host) => ({ service, router, host }))
    },
  )
}

export function routerHosts(
  services: typeof ComposeDocument.Type.services,
): ReadonlyArray<RouterHost> {
  return pipe(
    Record.toEntries(services),
    Array.flatMap(serviceRouterHosts),
    Array.dedupeWith(
      (self, that) =>
        self.service === that.service &&
        self.router === that.router &&
        self.host === that.host,
    ),
  )
}

export function routerHostLine({ service, router, host }: RouterHost): string {
  return `${host} (router ${router} of service ${service})`
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
    routerHosts: routerHosts(decoded.services),
  }
}
