import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { ActionInputs } from '#action-inputs.config.ts'
import {
  OpenBaoMetadata,
  OpenBaoRequestError,
} from '#openbao/openbao-metadata.ts'

const token = 'test-openbao-token'

interface SeenRequest {
  readonly url: string
  readonly token: string | undefined
  readonly namespace: string | undefined
}

function metadata({
  current,
  deletionTime = '',
  destroyed = false,
}: {
  readonly current: number
  readonly deletionTime?: string
  readonly destroyed?: boolean
}) {
  return {
    data: {
      current_version: current,
      custom_metadata: { owner: 'demo' },
      versions: {
        [String(current)]: {
          destroyed,
          created_time: '2026-11-21T10:00:00Z',
          deletion_time: deletionTime,
        },
      },
    },
  }
}

function fakeOpenBao({
  status,
  body,
}: {
  readonly status: number
  readonly body: unknown
}) {
  const seen: Array<SeenRequest> = []
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      seen.push({
        url: url.href,
        token: request.headers['x-vault-token'],
        namespace: request.headers['x-vault-namespace'],
      })
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )
  const layer = OpenBaoMetadata.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        ActionInputs.buildTestLayer({
          openbao: Option.some({
            url: new URL('https://bao.example.com/'),
            token: Redacted.make(token),
          }),
        }),
      ),
    ),
  )
  return { seen, layer }
}

function stateOf({
  layer,
  namespace = Option.none(),
}: {
  readonly layer: Layer.Layer<OpenBaoMetadata>
  readonly namespace?: Option.Option<string>
}) {
  return OpenBaoMetadata.pipe(
    Effect.flatMap((metadata) =>
      metadata.secretState({
        namespace,
        mount: 'octant',
        path: 'prod/postgres',
      }),
    ),
    Effect.provide(layer),
    Effect.withSpan('OpenBaoMetadataTest.stateOf'),
  )
}

describe('OpenBaoMetadata', () => {
  effect('should read the metadata of the path with the token', () =>
    Effect.gen(function* () {
      // Given: OpenBao holding a live current version
      const { seen, layer } = fakeOpenBao({
        status: 200,
        body: metadata({ current: 3 }),
      })

      // When: asking for the state of the secret
      const state = yield* stateOf({ layer })

      // Then: it is live, read from the metadata endpoint only
      expect(state).toBe('live')
      expect(seen).toEqual([
        {
          token,
          url: 'https://bao.example.com/v1/octant/metadata/prod/postgres',
          namespace: undefined,
        },
      ])
    }),
  )

  effect('should send the namespace of the provider', () =>
    Effect.gen(function* () {
      // Given: a provider reading a namespace
      const { seen, layer } = fakeOpenBao({
        status: 200,
        body: metadata({ current: 1 }),
      })

      // When: asking for the state of the secret
      yield* stateOf({ layer, namespace: Option.some('dev') })

      // Then: the namespace header is set
      expect(seen[0]?.namespace).toBe('dev')
    }),
  )

  effect('should report a path OpenBao does not know as missing', () =>
    Effect.gen(function* () {
      // Given: OpenBao answering 404
      const { layer } = fakeOpenBao({ status: 404, body: { errors: [] } })

      // When: asking for the state of the secret
      const state = yield* stateOf({ layer })

      // Then: it is missing
      expect(state).toBe('missing')
    }),
  )

  effect('should report a deleted current version', () =>
    Effect.gen(function* () {
      // Given: a current version soft-deleted
      const { layer } = fakeOpenBao({
        status: 200,
        body: metadata({ current: 2, deletionTime: '2026-11-21T11:00:00Z' }),
      })

      // When: asking for the state of the secret
      const state = yield* stateOf({ layer })

      // Then: it is deleted
      expect(state).toBe('deleted')
    }),
  )

  effect('should report a destroyed current version', () =>
    Effect.gen(function* () {
      // Given: a current version destroyed
      const { layer } = fakeOpenBao({
        status: 200,
        body: metadata({ current: 2, destroyed: true }),
      })

      // When: asking for the state of the secret
      const state = yield* stateOf({ layer })

      // Then: it is destroyed
      expect(state).toBe('destroyed')
    }),
  )

  effect('should fail on a refused token without printing it', () =>
    Effect.gen(function* () {
      // Given: OpenBao refusing the token
      const { layer } = fakeOpenBao({
        status: 403,
        body: { errors: ['permission denied'] },
      })

      // When: asking for the state of the secret
      const error = yield* Effect.flip(stateOf({ layer }))

      // Then: the error names the secret and the status, never the token
      expect(error).toBeInstanceOf(OpenBaoRequestError)
      expect(error.message).toContain('octant/prod/postgres')
      expect(error.message).toContain('403')
      expect(error.message).not.toContain(token)
    }),
  )

  effect('should refuse a redirect instead of following it', () =>
    Effect.gen(function* () {
      // Given: OpenBao answering a redirect
      const { layer } = fakeOpenBao({ status: 307, body: {} })

      // When: asking for the state of the secret
      const error = yield* Effect.flip(stateOf({ layer }))

      // Then: it fails
      expect(error.status).toBe(307)
    }),
  )

  effect('should be disabled without an openbao-token', () =>
    Effect.gen(function* () {
      // Given: no OpenBao access in the inputs
      const layer = OpenBaoMetadata.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die('no call expected')),
            ),
            ActionInputs.testLayer,
          ),
        ),
      )

      // When: reading the service
      const service = yield* Effect.provide(
        Effect.service(OpenBaoMetadata),
        layer,
      )

      // Then: it is off
      expect(service.enabled).toBe(false)
    }),
  )
})
