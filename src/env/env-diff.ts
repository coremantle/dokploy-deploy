import { Array, Order, pipe } from 'effect'

export interface EnvDiff {
  readonly drift: boolean
  readonly added: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
}

const assignment = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*=(.*)$/u

const quotes = new Set(['"', "'", '`'])

interface ParseState {
  readonly entries: ReadonlyArray<readonly [string, string]>
  readonly open: { readonly key: string; readonly quote: string } | undefined
}

function closes({
  text,
  quote,
}: {
  readonly text: string
  readonly quote: string
}) {
  return text.includes(quote)
}

function appendTo({
  state,
  key,
  line,
}: {
  readonly state: ParseState
  readonly key: string
  readonly line: string
}): ReadonlyArray<readonly [string, string]> {
  const last = state.entries.at(-1)
  const previous = last?.[0] === key ? last[1] : ''
  const entry: readonly [string, string] = [key, `${previous}\n${line}`]
  return [...state.entries.slice(0, -1), entry]
}

function readLine(state: ParseState, line: string): ParseState {
  if (state.open !== undefined) {
    const { key, quote } = state.open
    return {
      entries: appendTo({ state, key, line }),
      open: closes({ quote, text: line }) ? undefined : state.open,
    }
  }
  const trimmed = line.trim()
  const match = assignment.exec(trimmed)
  if (trimmed.startsWith('#') || match === null) return state
  const [, key = '', rawValue = ''] = match
  const value = rawValue.trim()
  const quote = value.charAt(0)
  const opens =
    quotes.has(quote) &&
    !(value.length > 1 && closes({ quote, text: value.slice(1) }))
  const entry: readonly [string, string] = [key, value]
  return {
    entries: [...state.entries, entry],
    open: opens ? { key, quote } : undefined,
  }
}

export function envEntries(env: string): ReadonlyMap<string, string> {
  const initial: ParseState = { entries: [], open: undefined }
  return new Map(Array.reduce(env.split(/\r?\n/u), initial, readLine).entries)
}

function sortedKeys(
  entries: ReadonlyMap<string, string>,
  keep: (key: string) => boolean,
) {
  return pipe(
    Array.fromIterable(entries.keys()),
    Array.filter(keep),
    Array.sort(Order.String),
  )
}

export function diffEnv({
  current,
  desired,
}: {
  readonly current: string
  readonly desired: string
}): EnvDiff {
  const currentEntries = envEntries(current)
  const desiredEntries = envEntries(desired)
  return {
    drift: current !== desired,
    added: sortedKeys(desiredEntries, (key) => !currentEntries.has(key)),
    removed: sortedKeys(currentEntries, (key) => !desiredEntries.has(key)),
    changed: sortedKeys(
      desiredEntries,
      (key) =>
        currentEntries.has(key) &&
        currentEntries.get(key) !== desiredEntries.get(key),
    ),
  }
}
