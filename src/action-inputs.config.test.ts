import { describe, effect, expect } from '@effect/vitest'
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted } from 'effect'

import { ActionInputs, inputVariables } from '#action-inputs.config.ts'

const validInputs = {
  [inputVariables.apiUrl]: 'https://dokploy.example.com/api',
  [inputVariables.apiKey]: 'test-dokploy-api-key',
  [inputVariables.manifest]: 'deploy/dokploy.yml',
  [inputVariables.mode]: 'plan',
  [inputVariables.environment]: 'production',
}

function layerWithEnvironment(values: Record<string, string>) {
  return ActionInputs.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
  )
}

const pullRequestInputs = {
  ...validInputs,
  [inputVariables.token]: 'test-forge-token',
  [inputVariables.prComment]: 'true',
  [inputVariables.forgeApiUrl]: 'https://api.github.com',
  [inputVariables.repository]: 'coremantle/demo',
  [inputVariables.pullRequest]: '12',
}

describe('ActionInputs on a forge', () => {
  effect('should decode the token and the pull request context', () =>
    Effect.gen(function* () {
      // Given: the inputs of a run on a pull request
      const environment = pullRequestInputs

      // When: reading the inputs
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: each one is decoded, the token redacted
      expect(Option.map(inputs.token, Redacted.value)).toEqual(
        Option.some('test-forge-token'),
      )
      expect(inputs.prComment).toBe(true)
      expect(Option.map(inputs.forge.apiUrl, ({ host }) => host)).toEqual(
        Option.some('api.github.com'),
      )
      expect(inputs.forge.repository).toEqual(Option.some('coremantle/demo'))
      expect(inputs.forge.pullRequest).toEqual(Option.some(12))
    }),
  )

  effect('should read a blank pull request number as no pull request', () =>
    Effect.gen(function* () {
      // Given: a push event, where the composite step passes an empty number
      const environment = {
        ...pullRequestInputs,
        [inputVariables.pullRequest]: '',
        [inputVariables.token]: '',
      }

      // When: reading the inputs
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: there is no pull request and no token
      expect(inputs.forge.pullRequest).toEqual(Option.none())
      expect(inputs.token).toEqual(Option.none())
    }),
  )

  effect('should default to commenting when the forge inputs are absent', () =>
    Effect.gen(function* () {
      // Given: a local run, with only the five Dokploy inputs
      const environment = validInputs

      // When: reading the inputs
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: nothing about the forge is known
      expect(inputs.prComment).toBe(true)
      expect(inputs.forge.apiUrl).toEqual(Option.none())
      expect(inputs.forge.pullRequest).toEqual(Option.none())
    }),
  )

  effect('should refuse a pr-comment other than true or false', () =>
    Effect.gen(function* () {
      // Given: a misspelt switch
      const environment = {
        ...pullRequestInputs,
        [inputVariables.prComment]: 'yes',
      }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails instead of guessing
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should trim pr-comment like every other input', () =>
    Effect.gen(function* () {
      // Given: a templated value with a trailing space
      const environment = {
        ...pullRequestInputs,
        [inputVariables.prComment]: 'false ',
      }

      // When: reading the inputs
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: it reads as false
      expect(inputs.prComment).toBe(false)
    }),
  )

  effect('should accept a forge served over http, so apply still runs', () =>
    Effect.gen(function* () {
      // Given: a self-hosted Forgejo over http
      const environment = {
        ...pullRequestInputs,
        [inputVariables.forgeApiUrl]: 'http://forge.example.com/api/v1',
      }

      // When: reading the inputs
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: the URL is kept; commenting is what refuses it
      expect(
        Option.map(inputs.forge.apiUrl, ({ protocol }) => protocol),
      ).toEqual(Option.some('http:'))
    }),
  )

  effect('should refuse a pull request number that is not a number', () =>
    Effect.gen(function* () {
      // Given: a garbled number
      const environment = {
        ...pullRequestInputs,
        [inputVariables.pullRequest]: '12abc',
      }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )
})

describe('ActionInputs', () => {
  effect('should decode the five inputs the composite step passes', () =>
    Effect.gen(function* () {
      // Given: every input set to a valid value
      const environment = {
        ...validInputs,
        [inputVariables.mode]: 'apply',
        [inputVariables.environment]: 'staging',
      }

      // When: reading the inputs
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: each one is decoded to its type
      expect(inputs.apiUrl.host).toBe('dokploy.example.com')
      expect(Redacted.value(inputs.apiKey)).toBe('test-dokploy-api-key')
      expect(inputs.manifest).toBe('deploy/dokploy.yml')
      expect(inputs.mode).toBe('apply')
      expect(inputs.environment).toBe('staging')
    }),
  )

  effect('should never render the api key when the inputs are printed', () =>
    Effect.gen(function* () {
      // Given: valid inputs
      const environment = validInputs

      // When: reading the inputs and printing the key
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: the printed form hides the value
      expect(String(inputs.apiKey)).not.toContain('test-dokploy-api-key')
    }),
  )

  effect('should refuse a mode other than plan or apply', () =>
    Effect.gen(function* () {
      // Given: a misspelt mode
      const environment = { ...validInputs, [inputVariables.mode]: 'deploy' }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails instead of guessing a mode
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should refuse an api url that is not a url', () =>
    Effect.gen(function* () {
      // Given: a host name without a scheme
      const environment = {
        ...validInputs,
        [inputVariables.apiUrl]: 'dokploy.example.com',
      }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails before calling anything
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should refuse a blank api key', () =>
    Effect.gen(function* () {
      // Given: a caller whose secret is missing, so the input arrives blank
      const environment = { ...validInputs, [inputVariables.apiKey]: '  ' }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails instead of calling Dokploy unauthenticated
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should refuse an api url that is not https', () =>
    Effect.gen(function* () {
      // Given: a plain http url, which would send the key in clear text
      const environment = {
        ...validInputs,
        [inputVariables.apiUrl]: 'http://dokploy.example.com/api',
      }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails before calling anything
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should refuse an api key spanning several lines', () =>
    Effect.gen(function* () {
      // Given: a secret pasted with a line break inside it
      const environment = {
        ...validInputs,
        [inputVariables.apiKey]: 'first-half\nsecond-half',
      }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails, so no half of the key can escape the mask
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should trim the line break a pasted secret often ends with', () =>
    Effect.gen(function* () {
      // Given: a key stored with a trailing newline
      const environment = {
        ...validInputs,
        [inputVariables.apiKey]: 'test-dokploy-api-key\n',
      }

      // When: reading the inputs
      const inputs = yield* ActionInputs.pipe(
        Effect.provide(layerWithEnvironment(environment)),
      )

      // Then: the key is kept without it
      expect(Redacted.value(inputs.apiKey)).toBe('test-dokploy-api-key')
    }),
  )

  effect('should refuse a manifest path holding a line break', () =>
    Effect.gen(function* () {
      // Given: a path that would print a workflow command on its own line
      const environment = {
        ...validInputs,
        [inputVariables.manifest]: 'deploy/dokploy.yml\n::warning::injected',
      }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails before logging the path
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should refuse an environment name that is not a manifest key', () =>
    Effect.gen(function* () {
      // Given: an environment typed with a capital and a space
      const environment = {
        ...validInputs,
        [inputVariables.environment]: 'Prod env',
      }

      // When: reading the inputs
      const outcome = yield* Effect.exit(
        ActionInputs.pipe(Effect.provide(layerWithEnvironment(environment))),
      )

      // Then: the action fails before reading the manifest
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )
})
