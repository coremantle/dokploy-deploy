import { Context, Effect, Layer, Option, Redacted, Schema, pipe } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import type { HttpClientResponse } from 'effect/http'

import type { OpenBaoAccess } from '#action-inputs.config.ts'
import { ActionInputs } from '#action-inputs.config.ts'
import { EffectService } from '#effect/index.ts'

const requestTimeoutSeconds = 30

const SecretMetadata = Schema.Struct({
  data: Schema.Struct({
    current_version: Schema.Int,
    versions: Schema.Record(
      Schema.String,
      Schema.Struct({
        deletion_time: Schema.String,
        destroyed: Schema.Boolean,
      }),
    ),
  }),
})

type SecretMetadata = typeof SecretMetadata.Type

export type SecretState = 'live' | 'missing' | 'deleted' | 'destroyed'

export interface OpenBaoSecretPath {
  readonly mount: string
  readonly namespace: Option.Option<string>
  readonly path: string
}

export function secretLocation({ mount, path }: OpenBaoSecretPath): string {
  return `${mount}/${path}`
}

export class OpenBaoRequestError extends Schema.TaggedError<OpenBaoRequestError>()(
  'OpenBaoRequestError',
  {
    secret: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    message: Schema.String,
  },
) {
  static fromStatus({
    secret,
    status,
  }: {
    readonly secret: string
    readonly status: number
  }): OpenBaoRequestError {
    const reason =
      status === 403
        ? 'the openbao-token may not read its metadata (or is invalid or expired)'
        : 'unexpected answer'
    return new OpenBaoRequestError({
      secret,
      status,
      message: `OpenBao answered ${status} on the metadata of ${secret}: ${reason}`,
    })
  }

  static because({
    secret,
    reason,
  }: {
    readonly secret: string
    readonly reason: string
  }): OpenBaoRequestError {
    return new OpenBaoRequestError({
      secret,
      message: `OpenBao metadata of ${secret}: ${reason}`,
    })
  }
}

export interface OpenBaoMetadataShape {
  readonly enabled: boolean
  readonly secretState: (
    secret: OpenBaoSecretPath,
  ) => Effect.Effect<SecretState, OpenBaoRequestError>
}

interface OpenBaoMetadataDependencies {
  readonly httpClient: HttpClient.HttpClient
  readonly access: OpenBaoAccess
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function stateOf({ data }: SecretMetadata): SecretState {
  const current = data.versions[String(data.current_version)]
  if (current === undefined) return 'missing'
  if (current.destroyed) return 'destroyed'
  return current.deletion_time === '' ? 'live' : 'deleted'
}

class HttpOpenBaoMetadata implements OpenBaoMetadataShape {
  readonly enabled = true

  private readonly dependencies: OpenBaoMetadataDependencies

  private constructor(dependencies: OpenBaoMetadataDependencies) {
    this.dependencies = dependencies
  }

  static make(dependencies: OpenBaoMetadataDependencies): HttpOpenBaoMetadata {
    return new HttpOpenBaoMetadata(dependencies)
  }

  secretState(secret: OpenBaoSecretPath) {
    const location = secretLocation(secret)
    const { access, httpClient } = this.dependencies
    const request = pipe(
      HttpClientRequest.get(
        `${access.url.href.replace(/\/+$/u, '')}/v1/${encodePath(secret.mount)}/metadata/${encodePath(secret.path)}`,
      ),
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader(
        'x-vault-token',
        Redacted.value(access.token),
      ),
      (bare) =>
        Option.match(secret.namespace, {
          onNone: () => bare,
          onSome: (namespace) =>
            HttpClientRequest.setHeader(bare, 'x-vault-namespace', namespace),
        }),
    )
    return pipe(
      httpClient.execute(request),
      // Why: fetch follows redirects by default and would re-send the token to the target; a 3xx must fail like any other non-2xx answer.
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: 'manual',
      }),
      Effect.mapError((cause) =>
        OpenBaoRequestError.because({
          secret: location,
          reason: `OpenBao could not be reached: ${cause.message}`,
        }),
      ),
      Effect.flatMap((response) => this.stateFrom({ location, response })),
      Effect.timeoutOrElse({
        duration: `${requestTimeoutSeconds} seconds`,
        orElse: () =>
          Effect.fail(
            OpenBaoRequestError.because({
              secret: location,
              reason: `OpenBao did not answer within ${requestTimeoutSeconds} seconds`,
            }),
          ),
      }),
      Effect.withSpan('OpenBaoMetadata.secretState', {
        attributes: { secret: location },
      }),
    )
  }

  private stateFrom({
    location,
    response,
  }: {
    readonly location: string
    readonly response: HttpClientResponse.HttpClientResponse
  }) {
    if (response.status === 404) return Effect.succeed<SecretState>('missing')
    return pipe(
      response.status === 200
        ? pipe(
            response.json,
            Effect.flatMap((body) =>
              Schema.decodeUnknownEffect(SecretMetadata)(body),
            ),
            Effect.map(stateOf),
            Effect.mapError((cause) =>
              OpenBaoRequestError.because({
                secret: location,
                reason: `unexpected body (is openbao-url the root of an OpenBao server?): ${cause.message}`,
              }),
            ),
          )
        : Effect.fail(
            OpenBaoRequestError.fromStatus({
              secret: location,
              status: response.status,
            }),
          ),
      Effect.withSpan('OpenBaoMetadata.stateFrom', {
        attributes: { secret: location, status: response.status },
      }),
    )
  }
}

const disabled: OpenBaoMetadataShape = {
  enabled: false,
  secretState: () => Effect.succeed('live'),
}

export class OpenBaoMetadata extends Context.Service<
  OpenBaoMetadata,
  OpenBaoMetadataShape
>()('dokploy-deploy/OpenBaoMetadata') {
  static readonly layer = Layer.effect(
    OpenBaoMetadata,
    Effect.map(
      EffectService.all({
        httpClient: HttpClient.HttpClient,
        inputs: ActionInputs,
      }),
      ({ httpClient, inputs }): OpenBaoMetadataShape =>
        Option.match(inputs.openbao, {
          onNone: () => disabled,
          onSome: (access) => HttpOpenBaoMetadata.make({ httpClient, access }),
        }),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<OpenBaoMetadataShape> = {},
  ) => OpenBaoMetadata.of({ ...disabled, ...shape })

  static readonly testLayer = Layer.succeed(
    OpenBaoMetadata,
    OpenBaoMetadata.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<OpenBaoMetadataShape>,
  ): Layer.Layer<OpenBaoMetadata> =>
    Layer.succeed(OpenBaoMetadata, OpenBaoMetadata.buildTestService(shape))
}
