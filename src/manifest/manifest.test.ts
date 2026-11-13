import { describe, effect, expect, it } from '@effect/vitest'
import { Effect, Exit, Schema } from 'effect'
import * as Yaml from 'effect/encoding/Yaml'

import {
  Manifest,
  manifestJsonSchema,
  manifestParseOptions,
} from '#manifest/manifest.ts'

const templateManifest = `
# yaml-language-server: $schema=https://raw.githubusercontent.com/coremantle/dokploy-deploy/v1/manifest.schema.json
version: 1
composeFile: docker-compose.dokploy.yml

secrets:
  folder: /template

environments:
  production:
    dokploy:
      project: template
      environment: production
      compose: template
    domain: template.example.com

domains:
  - service: template-web
    subdomain: app
    port: 3001
  - service: template-api
    subdomain: api
    port: 4000
`

function decode(yaml: string) {
  return Schema.decodeUnknownEffect(Manifest)(
    Yaml.parse(yaml),
    manifestParseOptions,
  )
}

function decodeExit(yaml: string) {
  return Effect.exit(decode(yaml))
}

describe('Manifest', () => {
  effect('should decode the ddd-template manifest with its defaults', () =>
    Effect.gen(function* () {
      // Given: the manifest the template ships
      const yaml = templateManifest

      // When: decoding it
      const manifest = yield* decode(yaml)

      // Then: every optional field takes its documented default
      expect(manifest.composeFile).toBe('docker-compose.dokploy.yml')
      expect(manifest.environments['production']?.secrets).toBeUndefined()
      expect(manifest.domains[0]).toEqual({
        service: 'template-web',
        subdomain: 'app',
        port: 3001,
        path: '/',
        https: true,
        certificateType: 'letsencrypt',
      })
    }),
  )

  effect('should default the compose file when the key is absent', () =>
    Effect.gen(function* () {
      // Given: a manifest without composeFile
      const yaml = templateManifest.replace(
        'composeFile: docker-compose.dokploy.yml\n',
        '',
      )

      // When: decoding it
      const manifest = yield* decode(yaml)

      // Then: the conventional compose file is used
      expect(manifest.composeFile).toBe('docker-compose.dokploy.yml')
    }),
  )

  effect('should keep an explicit provider and domain options', () =>
    Effect.gen(function* () {
      // Given: a provider and a fully specified domain
      const yaml = templateManifest
        .replace(
          '    domain: template.example.com',
          '    secrets:\n      provider: template-prod\n    domain: template.example.com',
        )
        .replace(
          '    port: 4000',
          '    port: 4000\n    path: /v1\n    https: false\n    certificateType: none\n    allowedMethods: [GET, HEAD]',
        )

      // When: decoding it
      const manifest = yield* decode(yaml)

      // Then: the declared values win over the defaults
      expect(manifest.environments['production']?.secrets?.provider).toBe(
        'template-prod',
      )
      expect(manifest.domains[1]).toEqual({
        service: 'template-api',
        subdomain: 'api',
        port: 4000,
        path: '/v1',
        https: false,
        certificateType: 'none',
        allowedMethods: ['GET', 'HEAD'],
      })
    }),
  )

  effect('should refuse an unknown key instead of ignoring it', () =>
    Effect.gen(function* () {
      // Given: a typo in a domain key
      const yaml = templateManifest.replace('    port: 4000', '    prot: 4000')

      // When: decoding it
      const outcome = yield* decodeExit(yaml)

      // Then: decoding fails and names the misspelt key
      expect(Exit.isFailure(outcome)).toBe(true)
      expect(String(outcome)).toContain('prot')
    }),
  )

  effect('should refuse a version other than 1', () =>
    Effect.gen(function* () {
      // Given: a manifest of a later major version
      const yaml = templateManifest.replace('version: 1', 'version: 2')

      // When: decoding it
      const outcome = yield* decodeExit(yaml)

      // Then: the action does not guess the shape
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should refuse a manifest without any environment', () =>
    Effect.gen(function* () {
      // Given: an empty environments map
      const yaml = templateManifest.replace(
        /environments:[\s\S]*?domains:/u,
        'environments: {}\n\ndomains:',
      )

      // When: decoding it
      const outcome = yield* decodeExit(yaml)

      // Then: decoding fails
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  effect('should refuse a manifest without any domain', () =>
    Effect.gen(function* () {
      // Given: an empty domain list
      const yaml = templateManifest.replace(
        /domains:[\s\S]*$/u,
        'domains: []\n',
      )

      // When: decoding it
      const outcome = yield* decodeExit(yaml)

      // Then: decoding fails
      expect(Exit.isFailure(outcome)).toBe(true)
    }),
  )

  it.each([
    {
      label: 'a subdomain spanning two labels',
      from: '    subdomain: app',
      to: '    subdomain: app.eu',
    },
    {
      label: 'a port out of range',
      from: '    port: 3001',
      to: '    port: 70000',
    },
    {
      label: 'a relative secrets folder',
      from: '  folder: /template',
      to: '  folder: template',
    },
    {
      label: 'a folder holding a brace',
      from: '  folder: /template',
      to: '  folder: /tem}plate',
    },
    {
      label: 'an uppercase parent domain',
      from: 'domain: template.example.com',
      to: 'domain: Template.example.com',
    },
    {
      label: 'a compose file outside the workspace',
      from: 'composeFile: docker-compose.dokploy.yml',
      to: 'composeFile: ../other.yml',
    },
    {
      label: 'an absolute compose file',
      from: 'composeFile: docker-compose.dokploy.yml',
      to: 'composeFile: /etc/compose.yml',
    },
    {
      label: 'an environment name with a capital',
      from: '  production:',
      to: '  Production:',
    },
    {
      label: 'a Dokploy name with a trailing space',
      from: '      project: template',
      to: "      project: 'template '",
    },
  ])('should refuse $label', ({ from, to }) => {
    // Given: the template manifest with one invalid value
    const yaml = templateManifest.replace(from, to)

    // When: decoding it
    const outcome = Effect.runSyncExit(decode(yaml))

    // Then: decoding fails
    expect(yaml).not.toBe(templateManifest)
    expect(Exit.isFailure(outcome)).toBe(true)
  })

  it('should refuse a provider name Dokploy would not accept', () => {
    // Given: a provider name holding a dot
    const yaml = templateManifest.replace(
      '    domain: template.example.com',
      '    secrets:\n      provider: template.prod\n    domain: template.example.com',
    )

    // When: decoding it
    const outcome = Effect.runSyncExit(decode(yaml))

    // Then: decoding fails
    expect(Exit.isFailure(outcome)).toBe(true)
  })

  it('should refuse the same allowed method twice', () => {
    // Given: GET listed twice
    const yaml = templateManifest.replace(
      '    port: 4000',
      '    port: 4000\n    allowedMethods: [GET, GET]',
    )

    // When: decoding it
    const outcome = Effect.runSyncExit(decode(yaml))

    // Then: decoding fails
    expect(Exit.isFailure(outcome)).toBe(true)
  })
})

describe('manifestJsonSchema', () => {
  it('should publish a closed JSON Schema with the required keys', () => {
    // Given: the manifest schema

    // When: rendering it as a JSON Schema
    const jsonSchema = manifestJsonSchema()

    // Then: editors reject unknown keys and see the required ones
    expect(jsonSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      required: ['version', 'secrets', 'environments', 'domains'],
    })
  })
})
