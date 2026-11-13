import { Effect, Record } from 'effect'
import type { Context } from 'effect'

type ServiceKeys = { readonly [key: string]: Context.Service.Any }

type ServicesOf<Keys extends ServiceKeys> = {
  -readonly [K in keyof Keys]: Context.Service.Shape<Keys[K]>
}

type RequirementsOf<Keys extends ServiceKeys> = Context.Service.Identifier<
  Keys[keyof Keys]
>

export function all<const Keys extends ServiceKeys>(
  keys: Keys,
): Effect.Effect<ServicesOf<Keys>, never, RequirementsOf<Keys>>
// Why: `Record.map` widens the record to `string` keys, so the precise signature is the overload above and this one only reads each key.
export function all(keys: ServiceKeys) {
  return Effect.all(Record.map(keys, (key) => Effect.service(key)))
}
