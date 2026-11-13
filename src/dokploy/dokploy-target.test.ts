import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'

import type { DokployProject, VaultProvider } from '#dokploy/dokploy-client.ts'
import {
  DokployTargetError,
  VaultProviderError,
  findVaultProvider,
  resolveTarget,
} from '#dokploy/dokploy-target.ts'

const projects: ReadonlyArray<DokployProject> = [
  {
    projectId: 'project-demo',
    name: 'Demo',
    environments: [
      {
        environmentId: 'environment-production',
        name: 'production',
        compose: [
          { composeId: 'compose-hello', name: 'hello' },
          { composeId: 'compose-twin-1', name: 'twin' },
          { composeId: 'compose-twin-2', name: 'twin' },
        ],
      },
    ],
  },
]

const names = { project: 'Demo', environment: 'production', compose: 'hello' }

const provider: VaultProvider = {
  vaultProviderId: 'provider-demo',
  name: 'infisical-demo',
  providerType: 'infisical',
  config: { secretPath: '/demo/hello' },
}

describe('resolveTarget', () => {
  effect('should resolve the names of the manifest to Dokploy ids', () =>
    Effect.gen(function* () {
      // Given: the projects the key sees

      // When: resolving the manifest's names
      const target = yield* resolveTarget({ projects, names })

      // Then: the ids of the project, environment and compose are returned
      expect(target).toEqual({
        projectId: 'project-demo',
        environmentId: 'environment-production',
        composeId: 'compose-hello',
      })
    }),
  )

  effect('should fail when the key sees no project of that name', () =>
    Effect.gen(function* () {
      // Given: a manifest copied from another application
      const otherNames = { ...names, project: 'Octant' }

      // When: resolving it
      const error = yield* Effect.flip(
        resolveTarget({ projects, names: otherNames }),
      )

      // Then: the action fails naming what it could not find
      expect(error).toEqual(
        DokployTargetError.notFound({
          kind: 'project',
          name: 'Octant',
          matches: 0,
        }),
      )
    }),
  )

  effect('should fail when the environment is not visible', () =>
    Effect.gen(function* () {
      // Given: an environment the key has no access to
      const otherNames = { ...names, environment: 'staging' }

      // When: resolving it
      const error = yield* Effect.flip(
        resolveTarget({ projects, names: otherNames }),
      )

      // Then: the environment is named
      expect(error).toMatchObject({
        kind: 'environment',
        dokployName: 'staging',
      })
    }),
  )

  effect('should refuse a name two composes share', () =>
    Effect.gen(function* () {
      // Given: two composes with the same name
      const twinNames = { ...names, compose: 'twin' }

      // When: resolving it
      const error = yield* Effect.flip(
        resolveTarget({ projects, names: twinNames }),
      )

      // Then: the action refuses to pick one
      expect(error).toEqual(
        DokployTargetError.notFound({
          kind: 'compose',
          name: 'twin',
          matches: 2,
        }),
      )
    }),
  )
})

describe('findVaultProvider', () => {
  effect('should find the Infisical provider reading the secrets folder', () =>
    Effect.gen(function* () {
      // Given: the provider babel created for the folder

      // When: looking it up
      const found = yield* findVaultProvider({
        providers: [provider],
        name: 'infisical-demo',
        folder: '/demo/hello',
      })

      // Then: it is returned
      expect(found).toBe(provider)
    }),
  )

  effect('should accept a provider path written with a trailing slash', () =>
    Effect.gen(function* () {
      // Given: a provider whose path ends with a slash
      const slashed = { ...provider, config: { secretPath: '/demo/hello/' } }

      // When: looking it up
      const found = yield* findVaultProvider({
        providers: [slashed],
        name: 'infisical-demo',
        folder: '/demo/hello',
      })

      // Then: it is the same folder
      expect(found).toBe(slashed)
    }),
  )

  effect('should fail when the provider is not visible', () =>
    Effect.gen(function* () {
      // Given: no provider of that name

      // When: looking it up
      const error = yield* Effect.flip(
        findVaultProvider({
          providers: [provider],
          name: 'infisical-template',
          folder: '/demo/hello',
        }),
      )

      // Then: the provider is named
      expect(error).toBeInstanceOf(VaultProviderError)
      expect(error.message).toContain('infisical-template is not visible')
    }),
  )

  effect('should refuse a provider that is not Infisical', () =>
    Effect.gen(function* () {
      // Given: a HashiCorp provider of the right name
      const vault = { ...provider, providerType: 'hashicorp', config: {} }

      // When: looking it up
      const error = yield* Effect.flip(
        findVaultProvider({
          providers: [vault],
          name: 'infisical-demo',
          folder: '/demo/hello',
        }),
      )

      // Then: the action refuses it
      expect(error.message).toContain('is a hashicorp provider')
    }),
  )

  effect('should refuse a provider reading another folder', () =>
    Effect.gen(function* () {
      // Given: a provider on the root folder, whose key list is not the folder's
      const rootProvider = { ...provider, config: { secretPath: '/' } }

      // When: looking it up for /demo/hello
      const error = yield* Effect.flip(
        findVaultProvider({
          providers: [rootProvider],
          name: 'infisical-demo',
          folder: '/demo/hello',
        }),
      )

      // Then: the mismatch is reported before any key is listed
      expect(error).toEqual(
        VaultProviderError.because({
          provider: 'infisical-demo',
          reason:
            "reads /, not the manifest's secrets folder /demo/hello: its key list would not match the references",
        }),
      )
    }),
  )
})
