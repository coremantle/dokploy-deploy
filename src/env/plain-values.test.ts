import { describe, effect, expect, it } from '@effect/vitest'
import { Effect, Exit, Option } from 'effect'

import {
  PlainValueCollisionError,
  checkPlainKeys,
  plainEntries,
  plainLine,
} from '#env/plain-values.ts'

describe('plainEntries', () => {
  it('should list the plain values sorted by key', () => {
    // Given: an environment with plain values written out of order
    const environment = {
      env: { PUBLIC_APP_URL: 'https://app.example.com', APP_ENVIRONMENT: '' },
    }

    // When: listing them
    const entries = plainEntries(environment)

    // Then: they come sorted, values untouched
    expect(entries).toEqual([
      { key: 'APP_ENVIRONMENT', value: '' },
      { key: 'PUBLIC_APP_URL', value: 'https://app.example.com' },
    ])
  })

  it('should list nothing for an environment without env', () => {
    // Given: an environment without plain values
    const environment = {}

    // When: listing them
    const entries = plainEntries(environment)

    // Then: the list is empty
    expect(entries).toEqual([])
  })
})

describe('plainLine', () => {
  it('should single-quote the value', () => {
    // Given: a plain value
    const entry = {
      key: 'ADMINISTRATOR_EMAILS',
      value: 'a@example.com,b@example.com',
    }

    // When: rendering its line
    const { line } = plainLine(entry)

    // Then: it is a single-quoted dotenv line
    expect(line).toBe("ADMINISTRATOR_EMAILS='a@example.com,b@example.com'\n")
  })
})

describe('checkPlainKeys', () => {
  effect('should accept plain keys apart from the secret keys', () =>
    Effect.gen(function* () {
      // Given: distinct plain and secret keys and a distinct version-env
      const plain = [{ key: 'APP_ENVIRONMENT', value: 'production' }]

      // When: checking them
      const exit = yield* Effect.exit(
        checkPlainKeys({
          plain,
          secretKeys: ['POSTGRES_PASSWORD'],
          version: Option.some({ key: 'APP_VERSION', value: '0123456789ab' }),
        }),
      )

      // Then: nothing is refused
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  effect('should refuse a plain key that is also the version-env', () =>
    Effect.gen(function* () {
      // Given: a plain value named like the version-env
      const plain = [{ key: 'APP_VERSION', value: 'v1' }]

      // When: checking them
      const error = yield* Effect.flip(
        checkPlainKeys({
          plain,
          secretKeys: [],
          version: Option.some({ key: 'APP_VERSION', value: '0123456789ab' }),
        }),
      )

      // Then: the collision names the version-env
      expect(error).toEqual(
        PlainValueCollisionError.forVersionKey('APP_VERSION'),
      )
    }),
  )

  effect('should name every plain key that is also a secret key, sorted', () =>
    Effect.gen(function* () {
      // Given: two plain values also held by the secrets source
      const plain = [
        { key: 'PUBLIC_URL', value: 'https://example.com' },
        { key: 'MESSAGE', value: 'hello' },
      ]

      // When: checking them
      const error = yield* Effect.flip(
        checkPlainKeys({
          plain,
          secretKeys: ['PUBLIC_URL', 'MESSAGE', 'OTHER'],
          version: Option.none(),
        }),
      )

      // Then: both are named
      expect(error).toEqual(
        PlainValueCollisionError.forSecretKeys(['MESSAGE', 'PUBLIC_URL']),
      )
    }),
  )
})
