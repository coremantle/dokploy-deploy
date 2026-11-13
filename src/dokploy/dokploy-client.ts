import { Context, Effect, Layer, Option, Redacted, Schema, pipe } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import type { HttpClientResponse } from 'effect/http'

import { ActionInputs } from '#action-inputs.config.ts'
import { EffectService } from '#effect/index.ts'

export const DokployCompose = Schema.Struct({
  composeId: Schema.String,
  name: Schema.String,
})

export const DokployEnvironment = Schema.Struct({
  environmentId: Schema.String,
  name: Schema.String,
  compose: Schema.Array(DokployCompose),
})

export const DokployProject = Schema.Struct({
  projectId: Schema.String,
  name: Schema.String,
  environments: Schema.Array(DokployEnvironment),
})

export type DokployProject = typeof DokployProject.Type

export const VaultProvider = Schema.Struct({
  vaultProviderId: Schema.String,
  name: Schema.String,
  providerType: Schema.String,
  config: Schema.Struct({
    secretPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
})

export type VaultProvider = typeof VaultProvider.Type

export const DokployComposeEnv = Schema.Struct({
  env: Schema.NullOr(Schema.String),
})

export const DokployDomain = Schema.Struct({
  domainId: Schema.String,
  host: Schema.String,
  path: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int),
  serviceName: Schema.NullOr(Schema.String),
  https: Schema.Boolean,
  certificateType: Schema.String,
})

export type DokployDomain = typeof DokployDomain.Type

const DokployErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
})

const bareUnauthorized = 'Unauthorized'

const requestTimeoutSeconds = 30

export class DokployUnauthorizedError extends Schema.TaggedError<DokployUnauthorizedError>()(
  'DokployUnauthorizedError',
  {
    endpoint: Schema.String,
    reason: Schema.Literals(['no-access', 'key-rejected']),
    message: Schema.String,
  },
) {
  static from({
    endpoint,
    dokployMessage,
  }: DokployAnswer): DokployUnauthorizedError {
    const refusal = Option.filter(
      dokployMessage,
      (message) => message !== bareUnauthorized,
    )
    return Option.isNone(refusal)
      ? new DokployUnauthorizedError({
          endpoint,
          reason: 'key-rejected',
          message: `Dokploy rejected the API key on ${endpoint} (401 Unauthorized): the key is unknown, expired or rate-limited; create CI keys with rateLimitEnabled: false`,
        })
      : new DokployUnauthorizedError({
          endpoint,
          reason: 'no-access',
          message: `Dokploy refused ${endpoint} (401): ${refusal.value}; the key's member has no access to it`,
        })
  }
}

export class DokployRequestError extends Schema.TaggedError<DokployRequestError>()(
  'DokployRequestError',
  {
    endpoint: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    message: Schema.String,
  },
) {
  static fromStatus({
    endpoint,
    status,
    dokployMessage,
  }: DokployAnswer & { readonly status: number }): DokployRequestError {
    return new DokployRequestError({
      endpoint,
      status,
      message: `Dokploy answered ${status} on ${endpoint}${Option.match(dokployMessage, { onNone: () => '', onSome: (message) => `: ${message}` })}`,
    })
  }

  static timedOut(endpoint: string): DokployRequestError {
    return new DokployRequestError({
      endpoint,
      message: `Dokploy did not answer ${endpoint} within ${requestTimeoutSeconds} seconds`,
    })
  }

  static unreachable({
    endpoint,
    reason,
  }: {
    readonly endpoint: string
    readonly reason: string
  }): DokployRequestError {
    return new DokployRequestError({
      endpoint,
      message: `Dokploy could not be reached on ${endpoint}: ${reason}`,
    })
  }
}

export class DokployResponseError extends Schema.TaggedError<DokployResponseError>()(
  'DokployResponseError',
  { endpoint: Schema.String, message: Schema.String },
) {
  static unexpected({
    endpoint,
    reason,
  }: {
    readonly endpoint: string
    readonly reason: string
  }): DokployResponseError {
    return new DokployResponseError({
      endpoint,
      message: `Dokploy answered ${endpoint} with an unexpected body (is api-url the /api of a supported Dokploy?): ${reason}`,
    })
  }
}

export type DokployError =
  | DokployUnauthorizedError
  | DokployRequestError
  | DokployResponseError

interface DokployAnswer {
  readonly endpoint: string
  readonly dokployMessage: Option.Option<string>
}

export interface SecretNamesQuery {
  readonly vaultProviderId: string
  readonly projectId: string
  readonly environmentId: string
}

export interface DomainSettings {
  readonly host: string
  readonly path: string
  readonly port: number
  readonly serviceName: string
  readonly https: boolean
  readonly certificateType: string
}

export interface DokployClientShape {
  readonly projects: Effect.Effect<ReadonlyArray<DokployProject>, DokployError>
  readonly vaultProviders: Effect.Effect<
    ReadonlyArray<VaultProvider>,
    DokployError
  >
  readonly listSecretNames: (
    query: SecretNamesQuery,
  ) => Effect.Effect<ReadonlyArray<string>, DokployError>
  readonly composeEnv: (
    composeId: string,
  ) => Effect.Effect<string, DokployError>
  readonly composeDomains: (
    composeId: string,
  ) => Effect.Effect<ReadonlyArray<DokployDomain>, DokployError>
  readonly saveEnvironment: (change: {
    readonly composeId: string
    readonly env: string
  }) => Effect.Effect<void, DokployError>
  readonly createDomain: (
    domain: DomainSettings & { readonly composeId: string },
  ) => Effect.Effect<void, DokployError>
  readonly updateDomain: (
    domain: DomainSettings & { readonly domainId: string },
  ) => Effect.Effect<void, DokployError>
  readonly deleteDomain: (domainId: string) => Effect.Effect<void, DokployError>
}

interface DokployClientDependencies {
  readonly httpClient: HttpClient.HttpClient
  readonly apiUrl: URL
  readonly apiKey: Redacted.Redacted<string>
}

interface DokployQuery<S extends Schema.Top> {
  readonly endpoint: string
  readonly schema: S
  readonly params?: Readonly<Record<string, string>>
}

interface DokployMutation {
  readonly endpoint: string
  readonly body: Readonly<Record<string, unknown>>
}

interface DokployCall<S extends Schema.Top> {
  readonly endpoint: string
  readonly schema: S
  readonly request: HttpClientRequest.HttpClientRequest
}

function errorFromStatus({
  endpoint,
  status,
  dokployMessage,
}: DokployAnswer & { readonly status: number }): DokployError {
  return status === 401
    ? DokployUnauthorizedError.from({ endpoint, dokployMessage })
    : DokployRequestError.fromStatus({ endpoint, status, dokployMessage })
}

class HttpDokployClient implements DokployClientShape {
  readonly projects: Effect.Effect<ReadonlyArray<DokployProject>, DokployError>

  readonly vaultProviders: Effect.Effect<
    ReadonlyArray<VaultProvider>,
    DokployError
  >

  private readonly dependencies: DokployClientDependencies

  private constructor(dependencies: DokployClientDependencies) {
    this.dependencies = dependencies
    this.projects = pipe(
      this.query({
        endpoint: 'project.all',
        schema: Schema.Array(DokployProject),
      }),
      Effect.withSpan('DokployClient.projects'),
    )
    this.vaultProviders = pipe(
      this.query({
        endpoint: 'vaultProvider.all',
        schema: Schema.Array(VaultProvider),
      }),
      Effect.withSpan('DokployClient.vaultProviders'),
    )
  }

  static make(dependencies: DokployClientDependencies): HttpDokployClient {
    return new HttpDokployClient(dependencies)
  }

  listSecretNames(query: SecretNamesQuery) {
    return pipe(
      this.query({
        endpoint: 'vaultProvider.listSecretNames',
        schema: Schema.Array(Schema.String),
        params: { ...query },
      }),
      Effect.withSpan('DokployClient.listSecretNames', {
        attributes: { vaultProviderId: query.vaultProviderId },
      }),
    )
  }

  composeEnv(composeId: string) {
    return pipe(
      this.query({
        endpoint: 'compose.one',
        schema: DokployComposeEnv,
        params: { composeId },
      }),
      Effect.map(({ env }) => env ?? ''),
      Effect.withSpan('DokployClient.composeEnv', {
        attributes: { composeId },
      }),
    )
  }

  composeDomains(composeId: string) {
    return pipe(
      this.query({
        endpoint: 'domain.byComposeId',
        schema: Schema.Array(DokployDomain),
        params: { composeId },
      }),
      Effect.withSpan('DokployClient.composeDomains', {
        attributes: { composeId },
      }),
    )
  }

  saveEnvironment({
    composeId,
    env,
  }: {
    readonly composeId: string
    readonly env: string
  }) {
    return pipe(
      this.mutate({
        endpoint: 'compose.saveEnvironment',
        body: { composeId, env },
      }),
      Effect.withSpan('DokployClient.saveEnvironment', {
        attributes: { composeId },
      }),
    )
  }

  createDomain(domain: DomainSettings & { readonly composeId: string }) {
    return pipe(
      this.mutate({
        endpoint: 'domain.create',
        body: { ...domain, domainType: 'compose' },
      }),
      Effect.withSpan('DokployClient.createDomain', {
        attributes: { host: domain.host, path: domain.path },
      }),
    )
  }

  updateDomain(domain: DomainSettings & { readonly domainId: string }) {
    return pipe(
      this.mutate({
        endpoint: 'domain.update',
        body: { ...domain, domainType: 'compose' },
      }),
      Effect.withSpan('DokployClient.updateDomain', {
        attributes: { domainId: domain.domainId, host: domain.host },
      }),
    )
  }

  deleteDomain(domainId: string) {
    return pipe(
      this.mutate({ endpoint: 'domain.delete', body: { domainId } }),
      Effect.withSpan('DokployClient.deleteDomain', {
        attributes: { domainId },
      }),
    )
  }

  private query<S extends Schema.Top & { readonly DecodingServices: never }>({
    endpoint,
    schema,
    params = {},
  }: DokployQuery<S>) {
    return pipe(
      this.send({
        endpoint,
        schema,
        request: pipe(
          HttpClientRequest.get(this.endpointUrl(endpoint)),
          HttpClientRequest.setUrlParams(params),
        ),
      }),
      Effect.withSpan('DokployClient.query', { attributes: { endpoint } }),
    )
  }

  private mutate({ endpoint, body }: DokployMutation) {
    return pipe(
      this.send({
        endpoint,
        schema: Schema.Unknown,
        request: pipe(
          HttpClientRequest.post(this.endpointUrl(endpoint)),
          HttpClientRequest.bodyText(JSON.stringify(body), 'application/json'),
        ),
      }),
      Effect.asVoid,
      Effect.withSpan('DokployClient.mutate', { attributes: { endpoint } }),
    )
  }

  private send<S extends Schema.Top & { readonly DecodingServices: never }>({
    endpoint,
    schema,
    request: bareRequest,
  }: DokployCall<S>) {
    const request = pipe(
      bareRequest,
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader(
        'x-api-key',
        Redacted.value(this.dependencies.apiKey),
      ),
    )
    return pipe(
      this.dependencies.httpClient.execute(request),
      // Why: fetch follows redirects by default and would re-send x-api-key to the target, even over http or to another host; a 3xx must fail like any other non-2xx answer.
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: 'manual',
      }),
      Effect.mapError((cause) =>
        DokployRequestError.unreachable({ endpoint, reason: cause.message }),
      ),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? this.decodeBody({ endpoint, schema, response })
          : this.failWith({ endpoint, response }),
      ),
      Effect.timeoutOrElse({
        duration: `${requestTimeoutSeconds} seconds`,
        orElse: () => Effect.fail(DokployRequestError.timedOut(endpoint)),
      }),
      Effect.withSpan('DokployClient.send', { attributes: { endpoint } }),
    )
  }

  private endpointUrl(endpoint: string) {
    return `${this.dependencies.apiUrl.href.replace(/\/+$/u, '')}/${endpoint}`
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
        DokployResponseError.unexpected({ endpoint, reason: cause.message }),
      ),
      Effect.withSpan('DokployClient.decodeBody', { attributes: { endpoint } }),
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
        Schema.decodeUnknownEffect(DokployErrorBody)(body),
      ),
      Effect.map(({ message }) => Option.fromUndefinedOr(message)),
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.flatMap((dokployMessage) =>
        Effect.fail(
          errorFromStatus({
            endpoint,
            dokployMessage,
            status: response.status,
          }),
        ),
      ),
      Effect.withSpan('DokployClient.failWith', {
        attributes: { endpoint, status: response.status },
      }),
    )
  }
}

export class DokployClient extends Context.Service<
  DokployClient,
  DokployClientShape
>()('dokploy-deploy/DokployClient') {
  static readonly layer = Layer.effect(
    DokployClient,
    Effect.map(
      EffectService.all({
        httpClient: HttpClient.HttpClient,
        inputs: ActionInputs,
      }),
      ({ httpClient, inputs: { apiUrl, apiKey } }) =>
        HttpDokployClient.make({ httpClient, apiUrl, apiKey }),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<DokployClientShape> = {},
  ) =>
    DokployClient.of({
      projects: Effect.succeed([]),
      vaultProviders: Effect.succeed([]),
      listSecretNames: () => Effect.succeed([]),
      composeEnv: () => Effect.succeed(''),
      composeDomains: () => Effect.succeed([]),
      saveEnvironment: () => Effect.void,
      createDomain: () => Effect.void,
      updateDomain: () => Effect.void,
      deleteDomain: () => Effect.void,
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    DokployClient,
    DokployClient.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<DokployClientShape>,
  ): Layer.Layer<DokployClient> =>
    Layer.succeed(DokployClient, DokployClient.buildTestService(shape))
}
