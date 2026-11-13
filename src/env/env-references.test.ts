import { describe, effect, expect, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'

import {
  InvalidSecretKeyError,
  MissingComposeVariablesError,
  NoSecretKeysError,
  ReferenceGuardError,
  checkComposeVariables,
  defaultProviderName,
  dokploySlug,
  guardFolder,
  renderEnvironment,
} from '#env/env-references.ts'

const demoSource = { provider: 'infisical-demo', folder: '/demo/hello' }

describe('renderEnvironment', () => {
  effect('should render the block babel pushes for the same folder', () =>
    Effect.gen(function* () {
      // Given: the keys of the Demo canary folder, imports included, unsorted
      const keys = ['MESSAGE', 'DEMO_MESSAGE', 'DEMO_IMPORTED']

      // When: rendering the environment block
      const block = yield* renderEnvironment({ ...demoSource, keys })

      // Then: one single-quoted absolute reference per key, sorted, newline-terminated
      expect(block).toBe(
        [
          "DEMO_IMPORTED='${{vault.infisical-demo./demo/hello:DEMO_IMPORTED}}'",
          "DEMO_MESSAGE='${{vault.infisical-demo./demo/hello:DEMO_MESSAGE}}'",
          "MESSAGE='${{vault.infisical-demo./demo/hello:MESSAGE}}'",
          '',
        ].join('\n'),
      )
    }),
  )

  effect('should render a key listed twice only once', () =>
    Effect.gen(function* () {
      // Given: a key overridden by the folder after an import lists it too
      const keys = ['MESSAGE', 'MESSAGE']

      // When: rendering the environment block
      const block = yield* renderEnvironment({ ...demoSource, keys })

      // Then: the reference appears once
      expect(block).toBe(
        "MESSAGE='${{vault.infisical-demo./demo/hello:MESSAGE}}'\n",
      )
    }),
  )

  effect('should render the same block whatever the order of the keys', () =>
    Effect.gen(function* () {
      // Given: the same keys listed in two orders, as two runs may get them
      const first = ['B_KEY', 'A.KEY', 'c-key']
      const second = ['c-key', 'B_KEY', 'A.KEY']

      // When: rendering both
      const blocks = yield* Effect.all([
        renderEnvironment({ ...demoSource, keys: first }),
        renderEnvironment({ ...demoSource, keys: second }),
      ])

      // Then: the blocks are identical, so a re-run reports no change
      expect(blocks[0]).toBe(blocks[1])
      expect(blocks[0]).toContain(
        "A.KEY='${{vault.infisical-demo./demo/hello:A.KEY}}'",
      )
    }),
  )

  effect('should refuse key names a reference cannot hold, naming them', () =>
    Effect.gen(function* () {
      // Given: names with a space, a colon and a closing brace
      const keys = ['GOOD', 'BAD KEY', 'BAD:KEY', 'BAD}KEY']

      // When: rendering the environment block
      const error = yield* Effect.flip(
        renderEnvironment({ ...demoSource, keys }),
      )

      // Then: the action fails and lists every invalid name, sorted
      expect(error).toEqual(
        InvalidSecretKeyError.forKeys(['BAD KEY', 'BAD:KEY', 'BAD}KEY']),
      )
    }),
  )

  effect('should refuse an empty key list', () =>
    Effect.gen(function* () {
      // Given: a provider that lists nothing, as a provider on the wrong path does
      const keys: Array<string> = []

      // When: rendering the environment block
      const error = yield* Effect.flip(
        renderEnvironment({ ...demoSource, keys }),
      )

      // Then: the action fails instead of wiping the environment
      expect(error).toEqual(NoSecretKeysError.forFolder(demoSource))
    }),
  )
})

describe('guardFolder', () => {
  it.each([
    { label: 'the project folder', folder: '/template', project: 'template' },
    {
      label: 'a folder under the project folder',
      folder: '/demo/hello',
      project: 'Demo',
    },
    { label: 'the shared folder', folder: '/shared', project: 'template' },
    {
      label: 'a folder under the shared folder',
      folder: '/shared/smtp',
      project: 'template',
    },
    {
      label: 'the slug of a project name with spaces',
      folder: '/viziertronic-legacy',
      project: 'Viziertronic Legacy',
    },
  ])('should allow $label', ({ folder, project }) => {
    // Given: a folder inside what the project may reference

    // When: guarding it
    const outcome = Effect.runSyncExit(guardFolder({ folder, project }))

    // Then: the guard lets it through
    expect(Exit.isSuccess(outcome)).toBe(true)
  })

  it.each([
    { label: 'another project folder', folder: '/octant', project: 'template' },
    {
      label: 'a sibling sharing the prefix',
      folder: '/template-other',
      project: 'template',
    },
    {
      label: 'a sibling of the shared folder',
      folder: '/shared-other',
      project: 'template',
    },
    { label: 'the root folder', folder: '/', project: 'template' },
  ])('should refuse $label', ({ folder, project }) => {
    // Given: a folder outside what the project may reference

    // When: guarding it
    const error = Effect.runSync(Effect.flip(guardFolder({ folder, project })))

    // Then: the guard refuses it before any reference is rendered
    expect(error).toEqual(ReferenceGuardError.outside({ folder, project }))
  })

  it('should only allow the shared folder for a project name without a slug', () => {
    // Given: a project name made of symbols only
    const project = '***'

    // When: guarding a folder named after nothing
    const outcome = Effect.runSyncExit(guardFolder({ project, folder: '/x' }))

    // Then: the guard refuses it
    expect(Exit.isFailure(outcome)).toBe(true)
  })
})

describe('defaultProviderName', () => {
  it.each([
    {
      label: 'production',
      project: 'template',
      environment: 'production',
      expected: 'infisical-template',
    },
    {
      label: 'another environment',
      project: 'template',
      environment: 'staging',
      expected: 'infisical-template-staging',
    },
    {
      label: 'names to slug',
      project: 'Viziertronic Legacy',
      environment: 'Pre Prod',
      expected: 'infisical-viziertronic-legacy-pre-prod',
    },
  ])(
    'should name the provider babel creates for $label',
    ({ project, environment, expected }) => {
      // Given: a Dokploy project and environment

      // When: deriving the default provider name
      const name = defaultProviderName({ project, environment })

      // Then: it is the name babel's onboarding gives the provider
      expect(name).toBe(expected)
    },
  )

  it('should cut the name at the 64 characters Dokploy allows', () => {
    // Given: a very long project name
    const project = 'p'.repeat(80)

    // When: deriving the default provider name
    const name = defaultProviderName({ project, environment: 'production' })

    // Then: the name fits Dokploy's limit
    expect(name).toHaveLength(64)
  })
})

describe('dokploySlug', () => {
  it('should lowercase and dash a Dokploy name like babel does', () => {
    // Given: a name with capitals, spaces and symbols around it
    const name = '  My App (v2)  '

    // When: slugging it
    const slug = dokploySlug(name)

    // Then: it matches babel's _slug
    expect(slug).toBe('my-app-v2')
  })
})

describe('checkComposeVariables', () => {
  effect('should pass when every required variable is a key', () =>
    Effect.gen(function* () {
      // Given: required variables all present among the keys
      const requiredVariables = ['DATABASE_URL']
      const keys = ['DATABASE_URL', 'EXTRA']

      // When: checking the compose file
      const outcome = yield* Effect.exit(
        checkComposeVariables({
          requiredVariables,
          keys,
          compose: 'compose.yml',
        }),
      )

      // Then: the check passes
      expect(Exit.isSuccess(outcome)).toBe(true)
    }),
  )

  effect('should fail naming every required variable that is not a key', () =>
    Effect.gen(function* () {
      // Given: two required variables missing from the folder
      const requiredVariables = ['A_KEY', 'B_MISSING', 'C_MISSING']
      const keys = ['A_KEY']

      // When: checking the compose file
      const error = yield* Effect.flip(
        checkComposeVariables({
          requiredVariables,
          keys,
          compose: 'compose.yml',
        }),
      )

      // Then: the action fails before writing anything, naming them
      expect(error).toEqual(
        MissingComposeVariablesError.forVariables({
          compose: 'compose.yml',
          variables: ['B_MISSING', 'C_MISSING'],
        }),
      )
    }),
  )
})
