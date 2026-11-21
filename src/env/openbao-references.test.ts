import { describe, effect, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import {
  DuplicateSecretKeyError,
  MissingSecretReferencesError,
  MountGuardError,
  VersionKeyMappedError,
  checkListedReferences,
  dokployListingLimit,
  guardMount,
  openBaoEntries,
  parseOpenBaoValue,
  referencesOf,
  renderOpenBaoEnvironment,
} from '#env/openbao-references.ts'

const octantSecrets = {
  openbao: {
    'octant-prod': {
      POSTGRES_PASSWORD: 'prod/postgres:password',
      DATABASE_URL:
        'postgres://${prod/postgres:username}:${prod/postgres:password}@octant-db:5432/octant',
    },
    'shared-prod': { DISCORD_CLIENT_ID: 'prod/oauth-discord:client_id' },
  },
}

describe('parseOpenBaoValue', () => {
  it('should read a bare reference as one reference', () => {
    // Given: a reference
    const value = 'prod/postgres:password'

    // When: parsing it
    const parts = parseOpenBaoValue(value)

    // Then: path and field are split at the last colon
    expect(parts).toEqual([
      { kind: 'reference', path: 'prod/postgres', field: 'password' },
    ])
  })

  it('should split a composed value into literals and references', () => {
    // Given: a URL embedding two references
    const value = 'postgres://${prod/pg:username}:${prod/pg:password}@db/app'

    // When: parsing it
    const parts = parseOpenBaoValue(value)

    // Then: the literals around the references are kept, in order
    expect(parts).toEqual([
      { kind: 'literal', text: 'postgres://' },
      { kind: 'reference', path: 'prod/pg', field: 'username' },
      { kind: 'literal', text: ':' },
      { kind: 'reference', path: 'prod/pg', field: 'password' },
      { kind: 'literal', text: '@db/app' },
    ])
  })
})

describe('openBaoEntries', () => {
  effect('should list every mapped key, sorted, with its provider', () =>
    Effect.gen(function* () {
      // Given: two providers of one environment

      // When: reading the entries
      const entries = yield* openBaoEntries(octantSecrets)

      // Then: one entry per key, sorted by key
      expect(entries.map(({ key, provider }) => [key, provider])).toEqual([
        ['DATABASE_URL', 'octant-prod'],
        ['DISCORD_CLIENT_ID', 'shared-prod'],
        ['POSTGRES_PASSWORD', 'octant-prod'],
      ])
    }),
  )

  effect('should refuse a key mapped by two providers', () =>
    Effect.gen(function* () {
      // Given: the same key under two providers
      const secrets = {
        openbao: {
          'octant-prod': { RESEND_API_KEY: 'prod/resend:api_key' },
          'shared-prod': { RESEND_API_KEY: 'prod/resend:api_key' },
        },
      }

      // When: reading the entries
      const error = yield* Effect.flip(openBaoEntries(secrets))

      // Then: the key is named
      expect(error).toEqual(DuplicateSecretKeyError.forKeys(['RESEND_API_KEY']))
    }),
  )
})

describe('referencesOf', () => {
  effect('should list each reference once per provider', () =>
    Effect.gen(function* () {
      // Given: a password read by two keys
      const entries = yield* openBaoEntries(octantSecrets)

      // When: listing the references
      const references = referencesOf(entries)

      // Then: each provider, path and field appears once
      expect(references).toEqual([
        { provider: 'octant-prod', path: 'prod/postgres', field: 'username' },
        { provider: 'octant-prod', path: 'prod/postgres', field: 'password' },
        {
          provider: 'shared-prod',
          path: 'prod/oauth-discord',
          field: 'client_id',
        },
      ])
    }),
  )
})

describe('renderOpenBaoEnvironment', () => {
  effect('should write one quoted Dokploy reference line per key', () =>
    Effect.gen(function* () {
      // Given: the entries of the environment
      const entries = yield* openBaoEntries(octantSecrets)

      // When: rendering the block
      const env = yield* renderOpenBaoEnvironment({ entries })

      // Then: each reference names its provider, its path and its field
      expect(env).toBe(
        [
          "DATABASE_URL='postgres://${{vault.octant-prod.prod/postgres:username}}:${{vault.octant-prod.prod/postgres:password}}@octant-db:5432/octant'",
          "DISCORD_CLIENT_ID='${{vault.shared-prod.prod/oauth-discord:client_id}}'",
          "POSTGRES_PASSWORD='${{vault.octant-prod.prod/postgres:password}}'",
          '',
        ].join('\n'),
      )
    }),
  )

  effect('should append the version line last', () =>
    Effect.gen(function* () {
      // Given: a version-env
      const entries = yield* openBaoEntries(octantSecrets)

      // When: rendering the block
      const env = yield* renderOpenBaoEnvironment({
        entries,
        version: Option.some({ key: 'APP_VERSION', value: '0123456789ab' }),
      })

      // Then: the plain line follows the references
      expect(env.endsWith('APP_VERSION=0123456789ab\n')).toBe(true)
    }),
  )

  effect('should refuse a version-env the mapping also holds', () =>
    Effect.gen(function* () {
      // Given: a version-env named like a mapped key
      const entries = yield* openBaoEntries(octantSecrets)

      // When: rendering the block
      const error = yield* Effect.flip(
        renderOpenBaoEnvironment({
          entries,
          version: Option.some({ key: 'DATABASE_URL', value: '0123456789ab' }),
        }),
      )

      // Then: the collision is reported
      expect(error).toEqual(VersionKeyMappedError.forKey('DATABASE_URL'))
    }),
  )
})

describe('guardMount', () => {
  for (const mount of ['octant', 'shared']) {
    effect(`should let project Octant read the mount ${mount}`, () =>
      Effect.gen(function* () {
        // Given: the app's own mount, or the shared one

        // When: guarding it
        const exit = yield* Effect.exit(
          guardMount({ mount, provider: 'p', project: 'Octant' }),
        )

        // Then: it passes
        expect(exit._tag).toBe('Success')
      }),
    )
  }

  effect('should refuse another application mount', () =>
    Effect.gen(function* () {
      // Given: a provider reading another app's mount
      const target = {
        provider: 'viziertronic-prod',
        mount: 'viziertronic',
        project: 'Octant',
      }

      // When: guarding it
      const error = yield* Effect.flip(guardMount(target))

      // Then: it is refused, naming the allowed mounts
      expect(error).toEqual(MountGuardError.outside(target))
      expect(error.message).toContain('octant and shared')
    }),
  )

  effect('should slug a project name to its mount', () =>
    Effect.gen(function* () {
      // Given: a project name with a space
      const target = {
        provider: 'viziertronic-legacy-prod',
        mount: 'viziertronic-legacy',
        project: 'Viziertronic Legacy',
      }

      // When: guarding it
      const exit = yield* Effect.exit(guardMount(target))

      // Then: it passes
      expect(exit._tag).toBe('Success')
    }),
  )
})

describe('checkListedReferences', () => {
  const references = [
    { provider: 'octant-prod', path: 'prod/postgres', field: 'password' },
    { provider: 'octant-prod', path: 'prod/resend', field: 'api_key' },
    { provider: 'shared-prod', path: 'prod/oauth-discord', field: 'client_id' },
  ]

  effect('should pass when the provider lists every reference', () =>
    Effect.gen(function* () {
      // Given: Dokploy listing both references of the provider
      const listed = ['prod/postgres:password', 'prod/resend:api_key']

      // When: checking them
      const unverified = yield* checkListedReferences({
        references,
        listed,
        provider: 'octant-prod',
      })

      // Then: nothing is left unverified
      expect(unverified).toEqual([])
    }),
  )

  effect('should fail on a reference the provider does not list', () =>
    Effect.gen(function* () {
      // Given: a field missing from the listing
      const listed = ['prod/postgres:password', 'prod/resend:token']

      // When: checking them
      const error = yield* Effect.flip(
        checkListedReferences({ references, listed, provider: 'octant-prod' }),
      )

      // Then: the missing path:field is named
      expect(error).toEqual(
        MissingSecretReferencesError.forReferences({
          provider: 'octant-prod',
          references: ['prod/resend:api_key'],
          listed: 2,
        }),
      )
    }),
  )

  effect('should hint at the token when the provider lists nothing', () =>
    Effect.gen(function* () {
      // Given: an empty listing

      // When: checking them
      const error = yield* Effect.flip(
        checkListedReferences({
          references,
          provider: 'octant-prod',
          listed: [],
        }),
      )

      // Then: the message points at the provider's token
      expect(error.message).toContain('list the mount')
    }),
  )

  effect('should only warn when the listing hit its limit', () =>
    Effect.gen(function* () {
      // Given: a listing truncated at Dokploy's limit
      const listed = Array.from(
        { length: dokployListingLimit },
        (_, index) => `prod/item-${index}:value`,
      )

      // When: checking them
      const unverified = yield* checkListedReferences({
        references,
        listed,
        provider: 'octant-prod',
      })

      // Then: the references not seen are returned as unverified
      expect(unverified).toEqual([
        'octant-prod:prod/postgres:password',
        'octant-prod:prod/resend:api_key',
      ])
    }),
  )
})
