import {
  Array,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  pipe,
} from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import type { HttpClientResponse } from 'effect/http'

import type { ForgeContext } from '#action-inputs.config.ts'
import { ActionInputs } from '#action-inputs.config.ts'
import { EffectService } from '#effect/index.ts'

const requestTimeoutSeconds = 30

const commentsPerPage = 50

const maxCommentPages = 20

const IssueComment = Schema.Struct({
  id: Schema.Int,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

type IssueComment = typeof IssueComment.Type

const ForgeErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
})

export class PullRequestCommentError extends Schema.TaggedError<PullRequestCommentError>()(
  'PullRequestCommentError',
  {
    endpoint: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    message: Schema.String,
  },
) {
  static insecure({ origin }: URL): PullRequestCommentError {
    return new PullRequestCommentError({
      endpoint: 'none',
      message: `the forge API ${origin} is not https: the token is never sent over it; set pr-comment: false`,
    })
  }

  static missing(input: string): PullRequestCommentError {
    return new PullRequestCommentError({
      endpoint: 'none',
      message: `pr-comment needs ${input} to comment on the pull request: set it, or set pr-comment: false`,
    })
  }

  static fromStatus({
    endpoint,
    status,
    forgeMessage,
  }: {
    readonly endpoint: string
    readonly status: number
    readonly forgeMessage: Option.Option<string>
  }): PullRequestCommentError {
    const hint =
      status === 401 || status === 403 || status === 404
        ? '; the token needs write access to the pull request (GitHub: permissions pull-requests: write; fork pull requests get a read-only token, set pr-comment: false there)'
        : ''
    return new PullRequestCommentError({
      endpoint,
      status,
      message: `the forge answered ${status} on ${endpoint}${Option.match(forgeMessage, { onNone: () => '', onSome: (message) => `: ${message}` })}${hint}`,
    })
  }

  static failed({
    endpoint,
    reason,
  }: {
    readonly endpoint: string
    readonly reason: string
  }): PullRequestCommentError {
    return new PullRequestCommentError({
      endpoint,
      message: `the pull request comment failed on ${endpoint}: ${reason}`,
    })
  }
}

export interface PlanComment {
  readonly marker: string
  readonly body: string
}

export interface PullRequestCommentsShape {
  readonly upsert: (
    comment: PlanComment,
  ) => Effect.Effect<void, PullRequestCommentError>
}

interface PullRequestTarget {
  readonly apiUrl: URL
  readonly repository: string
  readonly pullRequest: number
  readonly token: Redacted.Redacted<string>
}

interface PullRequestCommentsDependencies {
  readonly httpClient: HttpClient.HttpClient
  readonly forge: ForgeContext
  readonly token: Option.Option<Redacted.Redacted<string>>
}

interface ForgeCall<S extends Schema.Top> {
  readonly endpoint: string
  readonly schema: S
  readonly request: HttpClientRequest.HttpClientRequest
  readonly token: Redacted.Redacted<string>
}

function required<A>({
  value,
  input,
}: {
  readonly value: Option.Option<A>
  readonly input: string
}) {
  return pipe(
    value,
    Effect.fromOption(() => PullRequestCommentError.missing(input)),
    Effect.withSpan('PullRequestComments.required', { attributes: { input } }),
  )
}

class ForgePullRequestComments implements PullRequestCommentsShape {
  private readonly dependencies: PullRequestCommentsDependencies

  private constructor(dependencies: PullRequestCommentsDependencies) {
    this.dependencies = dependencies
  }

  static make(
    dependencies: PullRequestCommentsDependencies,
  ): ForgePullRequestComments {
    return new ForgePullRequestComments(dependencies)
  }

  upsert(comment: PlanComment) {
    return pipe(
      this.target(),
      Effect.flatMap((target) => this.upsertOn({ target, comment })),
      Effect.withSpan('PullRequestComments.upsert'),
    )
  }

  private upsertOn({
    target,
    comment,
  }: {
    readonly target: PullRequestTarget
    readonly comment: PlanComment
  }) {
    return pipe(
      this.findMarked({ target, marker: comment.marker, page: 1 }),
      Effect.flatMap(
        Option.match({
          onNone: () => this.create({ target, body: comment.body }),
          onSome: ({ id }) =>
            this.updateOrCreate({ target, id, body: comment.body }),
        }),
      ),
      Effect.withSpan('PullRequestComments.upsertOn'),
    )
  }

  private target() {
    const { forge, token } = this.dependencies
    return pipe(
      Effect.all({
        apiUrl: required({ value: forge.apiUrl, input: 'the forge API URL' }),
        repository: required({
          value: forge.repository,
          input: 'the repository',
        }),
        pullRequest: required({
          value: forge.pullRequest,
          input: 'the pull request number',
        }),
        token: required({ value: token, input: 'the token input' }),
      }),
      Effect.filterOrFail(
        ({ apiUrl }) => apiUrl.protocol === 'https:',
        ({ apiUrl }) => PullRequestCommentError.insecure(apiUrl),
      ),
      Effect.map((target): PullRequestTarget => target),
      Effect.withSpan('PullRequestComments.target'),
    )
  }

  private findMarked({
    target,
    marker,
    page,
    previousFirstId,
  }: {
    readonly target: PullRequestTarget
    readonly marker: string
    readonly page: number
    readonly previousFirstId?: number
  }): Effect.Effect<Option.Option<IssueComment>, PullRequestCommentError> {
    const endpoint = `issues/${target.pullRequest}/comments`
    return pipe(
      this.send({
        endpoint,
        token: target.token,
        schema: Schema.Array(IssueComment),
        request: pipe(
          HttpClientRequest.get(this.url({ target, path: endpoint })),
          HttpClientRequest.setUrlParams({
            page: String(page),
            per_page: String(commentsPerPage),
            limit: String(commentsPerPage),
          }),
        ),
      }),
      Effect.flatMap((comments) =>
        pipe(
          Array.findFirst(
            comments,
            ({ body }) => body?.startsWith(marker) ?? false,
          ),
          Option.match({
            onSome: (found) => Effect.succeed(Option.some(found)),
            onNone: () =>
              comments.length === 0 ||
              comments[0]?.id === previousFirstId ||
              page >= maxCommentPages
                ? Effect.succeed(Option.none<IssueComment>())
                : this.findMarked({
                    target,
                    marker,
                    page: page + 1,
                    previousFirstId: comments[0]?.id,
                  }),
          }),
        ),
      ),
      Effect.withSpan('PullRequestComments.findMarked', {
        attributes: { page },
      }),
    )
  }

  private create({
    target,
    body,
  }: {
    readonly target: PullRequestTarget
    readonly body: string
  }) {
    const endpoint = `issues/${target.pullRequest}/comments`
    return pipe(
      this.send({
        endpoint,
        token: target.token,
        schema: Schema.Unknown,
        request: pipe(
          HttpClientRequest.post(this.url({ target, path: endpoint })),
          HttpClientRequest.bodyText(
            JSON.stringify({ body }),
            'application/json',
          ),
        ),
      }),
      Effect.asVoid,
      Effect.withSpan('PullRequestComments.create'),
    )
  }

  private updateOrCreate({
    target,
    id,
    body,
  }: {
    readonly target: PullRequestTarget
    readonly id: number
    readonly body: string
  }) {
    return pipe(
      this.update({ target, id, body }),
      // Why: a comment carrying the marker but written by someone else cannot be edited with the job's token; the plan gets a comment of its own instead.
      Effect.catchIf(
        ({ status }) => status === 403 || status === 404,
        () => this.create({ target, body }),
      ),
      Effect.withSpan('PullRequestComments.updateOrCreate', {
        attributes: { id },
      }),
    )
  }

  private update({
    target,
    id,
    body,
  }: {
    readonly target: PullRequestTarget
    readonly id: number
    readonly body: string
  }) {
    const endpoint = `issues/comments/${id}`
    return pipe(
      this.send({
        endpoint,
        token: target.token,
        schema: Schema.Unknown,
        request: pipe(
          HttpClientRequest.patch(this.url({ target, path: endpoint })),
          HttpClientRequest.bodyText(
            JSON.stringify({ body }),
            'application/json',
          ),
        ),
      }),
      Effect.asVoid,
      Effect.withSpan('PullRequestComments.update', { attributes: { id } }),
    )
  }

  private url({
    target,
    path,
  }: {
    readonly target: PullRequestTarget
    readonly path: string
  }) {
    return `${target.apiUrl.href.replace(/\/+$/u, '')}/repos/${target.repository}/${path}`
  }

  private send<S extends Schema.Top & { readonly DecodingServices: never }>({
    endpoint,
    schema,
    token,
    request: bareRequest,
  }: ForgeCall<S>) {
    const request = pipe(
      bareRequest,
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeaders({
        authorization: `token ${Redacted.value(token)}`,
        'user-agent': 'dokploy-deploy',
      }),
    )
    return pipe(
      this.dependencies.httpClient.execute(request),
      // Why: fetch follows redirects by default and would re-send the token to the target; a 3xx must fail like any other non-2xx answer.
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: 'manual',
      }),
      Effect.mapError((cause) =>
        PullRequestCommentError.failed({ endpoint, reason: cause.message }),
      ),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? this.decodeBody({ endpoint, schema, response })
          : this.failWith({ endpoint, response }),
      ),
      Effect.timeoutOrElse({
        duration: `${requestTimeoutSeconds} seconds`,
        orElse: () =>
          Effect.fail(
            PullRequestCommentError.failed({
              endpoint,
              reason: `no answer within ${requestTimeoutSeconds} seconds`,
            }),
          ),
      }),
      Effect.withSpan('PullRequestComments.send', { attributes: { endpoint } }),
    )
  }

  private decodeBody<
    S extends Schema.Top & { readonly DecodingServices: never },
  >({
    endpoint,
    schema,
    response,
  }: {
    readonly endpoint: string
    readonly schema: S
    readonly response: HttpClientResponse.HttpClientResponse
  }) {
    return pipe(
      response.json,
      Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
      Effect.mapError((cause) =>
        PullRequestCommentError.failed({
          endpoint,
          reason: `unexpected answer: ${cause.message}`,
        }),
      ),
      Effect.withSpan('PullRequestComments.decodeBody', {
        attributes: { endpoint },
      }),
    )
  }

  private failWith({
    endpoint,
    response,
  }: {
    readonly endpoint: string
    readonly response: HttpClientResponse.HttpClientResponse
  }) {
    return pipe(
      response.json,
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(ForgeErrorBody)(body),
      ),
      Effect.map(({ message }) => Option.fromUndefinedOr(message)),
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.flatMap((forgeMessage) =>
        Effect.fail(
          PullRequestCommentError.fromStatus({
            endpoint,
            forgeMessage,
            status: response.status,
          }),
        ),
      ),
      Effect.withSpan('PullRequestComments.failWith', {
        attributes: { endpoint, status: response.status },
      }),
    )
  }
}

export class PullRequestComments extends Context.Service<
  PullRequestComments,
  PullRequestCommentsShape
>()('dokploy-deploy/PullRequestComments') {
  static readonly layer = Layer.effect(
    PullRequestComments,
    Effect.map(
      EffectService.all({
        httpClient: HttpClient.HttpClient,
        inputs: ActionInputs,
      }),
      ({ httpClient, inputs: { forge, token } }) =>
        ForgePullRequestComments.make({ httpClient, forge, token }),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<PullRequestCommentsShape> = {},
  ) =>
    PullRequestComments.of({
      upsert: () => Effect.void,
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    PullRequestComments,
    PullRequestComments.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<PullRequestCommentsShape>,
  ): Layer.Layer<PullRequestComments> =>
    Layer.succeed(
      PullRequestComments,
      PullRequestComments.buildTestService(shape),
    )
}
