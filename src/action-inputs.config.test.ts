import { describe, effect, expect } from '@effect/vitest'
import { ConfigProvider, Effect, Exit, Layer, Redacted } from 'effect'

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
