import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'
import { HttpBody, HttpClient, HttpClientResponse } from 'effect/http'
import type { HttpClientRequest } from 'effect/http'

import { ActionInputs } from '#action-inputs.config.ts'
import type { ActionInputsShape } from '#action-inputs.config.ts'
import {
  PullRequestCommentError,
  PullRequestComments,
} from '#pull-request-comments.ts'

const marker = '<!-- dokploy-deploy:plan:production -->'

const token = 'test-forge-token'

interface SeenRequest {
  readonly method: string
  readonly url: URL
  readonly authorization: string | undefined
  readonly body: string | undefined
}

interface FakeAnswer {
  readonly status: number
  readonly body: unknown
}

const onPullRequest: Partial<ActionInputsShape> = {
  token: Option.some(Redacted.make(token)),
  forge: {
    apiUrl: Option.some(new URL('https://forge.example.com/api/v1/')),
    repository: Option.some('coremantle/demo'),
    pullRequest: Option.some(12),
  },
}

function bodyText({ body }: HttpClientRequest.HttpClientRequest) {
  return body instanceof HttpBody.Uint8Array
    ? new TextDecoder().decode(body.body)
    : undefined
}

function fakeForge({
  answer,
  inputs = onPullRequest,
}: {
  readonly answer: (seen: SeenRequest) => FakeAnswer
  readonly inputs?: Partial<ActionInputsShape>
}) {
  const seen: Array<SeenRequest> = []
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const recorded: SeenRequest = {
        url,
        method: request.method,
        authorization: request.headers['authorization'],
        body: bodyText(request),
      }
      seen.push(recorded)
      const { status, body } = answer(recorded)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )
  const layer = PullRequestComments.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        ActionInputs.buildTestLayer(inputs),
      ),
    ),
  )
  return { seen, layer }
}

function upsert(layer: Layer.Layer<PullRequestComments>) {
  return PullRequestComments.pipe(
    Effect.flatMap((comments) =>
      comments.upsert({ marker, body: `${marker}\nplan` }),
    ),
    Effect.provide(layer),
    Effect.withSpan('PullRequestCommentsTest.upsert'),
  )
}

function pageOf(count: number, offset: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: offset + index,
    body: 'an unrelated comment',
  }))
}

describe('PullRequestComments', () => {
  effect('should create the comment when the pull request has none', () =>
    Effect.gen(function* () {
      // Given: a pull request with one unrelated comment
      const { seen, layer } = fakeForge({
        answer: ({ method, url }) => {
          if (method !== 'GET') return { status: 201, body: { id: 99 } }
          return url.searchParams.get('page') === '1'
            ? { status: 200, body: pageOf(1, 1) }
            : { status: 200, body: [] }
        },
      })

      // When: upserting the plan
      yield* upsert(layer)

      // Then: it lists the comments up to an empty page, then posts one with the token
      expect(
        seen.map(({ method, url }) => `${method} ${url.pathname}`),
      ).toEqual([
        'GET /api/v1/repos/coremantle/demo/issues/12/comments',
        'GET /api/v1/repos/coremantle/demo/issues/12/comments',
        'POST /api/v1/repos/coremantle/demo/issues/12/comments',
      ])
      expect(seen[0]?.authorization).toBe(`token ${token}`)
      expect(JSON.parse(seen[2]?.body ?? '{}')).toEqual({
        body: `${marker}\nplan`,
      })
    }),
  )

  effect('should update its own comment on the next run', () =>
    Effect.gen(function* () {
      // Given: a full first page, then the plan comment on the second
      const { seen, layer } = fakeForge({
        answer: ({ method, url }) => {
          if (method !== 'GET') return { status: 200, body: { id: 77 } }
          return url.searchParams.get('page') === '1'
            ? { status: 200, body: pageOf(50, 1) }
            : {
                status: 200,
                body: [{ id: 77, body: `${marker}\nprevious plan` }],
              }
        },
      })

      // When: upserting the plan
      yield* upsert(layer)

      // Then: the second page is read and the comment is edited in place
      expect(
        seen.map(({ method, url }) => `${method} ${url.pathname}`),
      ).toEqual([
        'GET /api/v1/repos/coremantle/demo/issues/12/comments',
        'GET /api/v1/repos/coremantle/demo/issues/12/comments',
        'PATCH /api/v1/repos/coremantle/demo/issues/comments/77',
      ])
    }),
  )

  effect('should ignore a comment that only quotes the marker', () =>
    Effect.gen(function* () {
      // Given: someone quoting the plan comment
      const { seen, layer } = fakeForge({
        answer: ({ method }) =>
          method === 'GET'
            ? { status: 200, body: [{ id: 5, body: `> ${marker}` }] }
            : { status: 201, body: { id: 6 } },
      })

      // When: upserting the plan
      yield* upsert(layer)

      // Then: a comment of its own is created
      expect(seen.at(-1)?.method).toBe('POST')
    }),
  )

  effect('should fail with a hint when the token cannot comment', () =>
    Effect.gen(function* () {
      // Given: a read-only token
      const { layer } = fakeForge({
        answer: ({ method }) =>
          method === 'GET'
            ? { status: 200, body: [] }
            : {
                status: 403,
                body: { message: 'Resource not accessible by integration' },
              },
      })

      // When: upserting the plan
      const error = yield* Effect.flip(upsert(layer))

      // Then: the status, the forge's words and the fix are in the error, never the token
      expect(error).toBeInstanceOf(PullRequestCommentError)
      expect(error).toMatchObject({ status: 403 })
      expect(error.message).toContain('Resource not accessible by integration')
      expect(error.message).toContain('pull-requests: write')
      expect(error.message).not.toContain(token)
    }),
  )

  effect(
    'should create its own comment when the marked one is not editable',
    () =>
      Effect.gen(function* () {
        // Given: a comment with the marker, written by someone else
        const { seen, layer } = fakeForge({
          answer: ({ method, url }) => {
            if (method === 'PATCH') return { status: 403, body: {} }
            if (method === 'POST') return { status: 201, body: { id: 8 } }
            return url.searchParams.get('page') === '1'
              ? { status: 200, body: [{ id: 7, body: `${marker}\nnot mine` }] }
              : { status: 200, body: [] }
          },
        })

        // When: upserting the plan
        yield* upsert(layer)

        // Then: the refused edit falls back to a new comment
        expect(seen.map(({ method }) => method)).toEqual([
          'GET',
          'PATCH',
          'POST',
        ])
      }),
  )

  effect('should find its comment past a page smaller than asked', () =>
    Effect.gen(function* () {
      // Given: a forge capping pages at 30 comments, the plan on page 2
      const { seen, layer } = fakeForge({
        answer: ({ method, url }) => {
          if (method !== 'GET') return { status: 200, body: { id: 77 } }
          return url.searchParams.get('page') === '1'
            ? { status: 200, body: pageOf(30, 1) }
            : { status: 200, body: [{ id: 77, body: `${marker}\nold` }] }
        },
      })

      // When: upserting the plan
      yield* upsert(layer)

      // Then: the comment is edited, not duplicated
      expect(seen.map(({ method }) => method)).toEqual(['GET', 'GET', 'PATCH'])
    }),
  )

  effect('should never send the token to a forge over http', () =>
    Effect.gen(function* () {
      // Given: a forge API over http
      const { seen, layer } = fakeForge({
        answer: () => ({ status: 200, body: [] }),
        inputs: {
          ...onPullRequest,
          forge: {
            apiUrl: Option.some(new URL('http://forge.example.com/api/v1')),
            repository: Option.some('coremantle/demo'),
            pullRequest: Option.some(12),
          },
        },
      })

      // When: upserting the plan
      const error = yield* Effect.flip(upsert(layer))

      // Then: it fails without any request
      expect(error.message).toContain('is not https')
      expect(seen).toEqual([])
    }),
  )

  effect('should stop paging when the forge ignores the page parameter', () =>
    Effect.gen(function* () {
      // Given: Forgejo answering every page with the same 50 comments
      const { seen, layer } = fakeForge({
        answer: ({ method }) =>
          method === 'GET'
            ? { status: 200, body: pageOf(50, 1) }
            : { status: 201, body: { id: 99 } },
      })

      // When: upserting the plan
      yield* upsert(layer)

      // Then: the repeated page ends the search, and the comment is created
      expect(seen.map(({ method }) => method)).toEqual(['GET', 'GET', 'POST'])
    }),
  )

  effect('should fail before calling the forge without a token', () =>
    Effect.gen(function* () {
      // Given: no token
      const { seen, layer } = fakeForge({
        answer: () => ({ status: 200, body: [] }),
        inputs: { ...onPullRequest, token: Option.none() },
      })

      // When: upserting the plan
      const error = yield* Effect.flip(upsert(layer))

      // Then: it names the missing input
      expect(error.message).toContain('the token input')
      expect(seen).toEqual([])
    }),
  )
})
