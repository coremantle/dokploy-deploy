import { describe, effect, expect } from '@effect/vitest'
import { Effect, FileSystem, Layer, PlatformError } from 'effect'

import { WorkspaceFileError, WorkspaceFiles } from '#workspace-files.ts'

function workspaceWith(files: Readonly<Record<string, string>>) {
  return WorkspaceFiles.layer.pipe(
    Layer.provide(
      FileSystem.layerNoop({
        readFileString: (path) =>
          path in files
            ? Effect.succeed(files[path] ?? '')
            : Effect.fail(
                PlatformError.systemError({
                  _tag: 'NotFound',
                  module: 'FileSystem',
                  method: 'readFileString',
                  description: 'no such file',
                  pathOrDescriptor: path,
                }),
              ),
      }),
    ),
  )
}

const manifest = `version: 1
secrets:
  folder: /demo
environments:
  production:
    dokploy: { project: Demo, environment: production, compose: hello }
    domain: demo.example.com
domains:
  - { service: hello, subdomain: hello, port: 8080 }
`

const compose = `services:
  hello:
    image: hello:\${IMAGE_TAG}
    environment:
      MESSAGE: \${MESSAGE}
      LEVEL: \${LEVEL:-info}
  worker:
    image: worker
`

describe('WorkspaceFiles', () => {
  effect('should read and decode the manifest', () =>
    Effect.gen(function* () {
      // Given: a workspace holding a valid manifest
      const layer = workspaceWith({ 'deploy/dokploy.yml': manifest })

      // When: reading it
      const decoded = yield* WorkspaceFiles.pipe(
        Effect.flatMap((files) => files.readManifest('deploy/dokploy.yml')),
        Effect.provide(layer),
      )

      // Then: it is decoded with its defaults
      expect(decoded.secrets.folder).toBe('/demo')
      expect(decoded.composeFile).toBe('docker-compose.dokploy.yml')
    }),
  )

  effect('should name the manifest path when the file is missing', () =>
    Effect.gen(function* () {
      // Given: a workspace without a manifest
      const layer = workspaceWith({})

      // When: reading it
      const error = yield* Effect.flip(
        WorkspaceFiles.pipe(
          Effect.flatMap((files) => files.readManifest('deploy/dokploy.yml')),
          Effect.provide(layer),
        ),
      )

      // Then: the error names the manifest and its path
      expect(error).toBeInstanceOf(WorkspaceFileError)
      expect(error.message).toMatch(/^manifest deploy\/dokploy\.yml: /u)
    }),
  )

  effect('should report a YAML syntax error in the manifest', () =>
    Effect.gen(function* () {
      // Given: a manifest with an unclosed flow sequence
      const layer = workspaceWith({ 'deploy/dokploy.yml': 'domains: [\n' })

      // When: reading it
      const error = yield* Effect.flip(
        WorkspaceFiles.pipe(
          Effect.flatMap((files) => files.readManifest('deploy/dokploy.yml')),
          Effect.provide(layer),
        ),
      )

      // Then: the action fails on the manifest
      expect(error).toMatchObject({
        kind: 'manifest',
        path: 'deploy/dokploy.yml',
      })
    }),
  )

  effect('should report every schema problem of the manifest at once', () =>
    Effect.gen(function* () {
      // Given: a manifest with two invalid fields
      const layer = workspaceWith({
        'deploy/dokploy.yml': manifest
          .replace('folder: /demo', 'folder: demo')
          .replace('port: 8080', 'port: 0'),
      })

      // When: reading it
      const error = yield* Effect.flip(
        WorkspaceFiles.pipe(
          Effect.flatMap((files) => files.readManifest('deploy/dokploy.yml')),
          Effect.provide(layer),
        ),
      )

      // Then: both are reported
      expect(error.message).toContain('folder')
      expect(error.message).toContain('port')
    }),
  )

  effect(
    'should read the services and required variables of the compose file',
    () =>
      Effect.gen(function* () {
        // Given: a compose file with two services
        const layer = workspaceWith({ 'docker-compose.dokploy.yml': compose })

        // When: reading it
        const composeFile = yield* WorkspaceFiles.pipe(
          Effect.flatMap((files) =>
            files.readCompose('docker-compose.dokploy.yml'),
          ),
          Effect.provide(layer),
        )

        // Then: services and the variables without a default are listed
        expect(composeFile).toEqual({
          services: ['hello', 'worker'],
          requiredVariables: ['IMAGE_TAG', 'MESSAGE'],
        })
      }),
  )

  effect('should refuse a compose file without services', () =>
    Effect.gen(function* () {
      // Given: a YAML file that is not a compose file
      const layer = workspaceWith({ 'docker-compose.dokploy.yml': 'name: x\n' })

      // When: reading it
      const error = yield* Effect.flip(
        WorkspaceFiles.pipe(
          Effect.flatMap((files) =>
            files.readCompose('docker-compose.dokploy.yml'),
          ),
          Effect.provide(layer),
        ),
      )

      // Then: the compose file is named
      expect(error).toMatchObject({
        kind: 'compose file',
        path: 'docker-compose.dokploy.yml',
      })
    }),
  )
})
