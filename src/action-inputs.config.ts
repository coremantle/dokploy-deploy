import { Config, Context, Layer, Option, Redacted, Schema } from 'effect'

import { DeployMode } from '#deploy-mode.ts'
import { isEnvironmentName } from '#manifest/manifest.ts'

export const inputVariables = {
  apiUrl: 'DOKPLOY_DEPLOY_API_URL',
  apiKey: 'DOKPLOY_DEPLOY_API_KEY',
  manifest: 'DOKPLOY_DEPLOY_MANIFEST',
  mode: 'DOKPLOY_DEPLOY_MODE',
  environment: 'DOKPLOY_DEPLOY_ENVIRONMENT',
  token: 'DOKPLOY_DEPLOY_TOKEN',
  prComment: 'DOKPLOY_DEPLOY_PR_COMMENT',
  forgeApiUrl: 'DOKPLOY_DEPLOY_FORGE_API_URL',
  repository: 'DOKPLOY_DEPLOY_REPOSITORY',
  pullRequest: 'DOKPLOY_DEPLOY_PULL_REQUEST',
} as const

const ManifestPath = Schema.Trim.check(
  Schema.isPattern(/^[^\p{Cc}]+$/u, {
    message: 'a manifest path is one non-empty line',
  }),
)

const ApiKey = Schema.Trim.check(
  Schema.isPattern(/^\S+$/u, {
    message: 'an API key is one word, without spaces or line breaks',
  }),
)

const EnvironmentName = Schema.Trim.check(isEnvironmentName)

const HttpsUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === 'https:', {
    message: 'the Dokploy API is only called over https',
  }),
)

const ForgeToken = Schema.Trim.check(
  Schema.isPattern(/^\S+$/u, {
    message: 'a token is one word, without spaces or line breaks',
  }),
)

const PrComment = Schema.Trim.check(
  Schema.isPattern(/^(?:true|false)$/u, {
    message: 'pr-comment is true or false',
  }),
)

const Repository = Schema.Trim.check(
  Schema.isPattern(/^[\w.-]+\/[\w.-]+$/u, {
    message: 'a repository is owner/name',
  }),
)

const PullRequestNumber = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
)

const Blank = Schema.Trim.check(Schema.isMaxLength(0))

function optionalInput<A>({
  schema,
  name,
}: {
  readonly schema: Schema.Codec<A, string>
  readonly name: string
}): Config.Config<Option.Option<A>> {
  return Config.schema(Blank, name).pipe(
    Config.map(() => Option.none<A>()),
    Config.orElse(() => Config.option(Config.schema(schema, name))),
  )
}

export interface ForgeContext {
  readonly apiUrl: Option.Option<URL>
  readonly repository: Option.Option<string>
  readonly pullRequest: Option.Option<number>
}

export interface ActionInputsShape {
  readonly apiUrl: URL
  readonly apiKey: Redacted.Redacted<string>
  readonly manifest: string
  readonly mode: DeployMode
  readonly environment: string
  readonly token: Option.Option<Redacted.Redacted<string>>
  readonly prComment: boolean
  readonly forge: ForgeContext
}

export class ActionInputs extends Context.Service<
  ActionInputs,
  ActionInputsShape
>()('dokploy-deploy/ActionInputs') {
  static readonly layer = Layer.effect(
    ActionInputs,
    Config.all({
      apiUrl: Config.schema(HttpsUrl, inputVariables.apiUrl),
      apiKey: Config.schema(
        Schema.RedactedFromValue(ApiKey),
        inputVariables.apiKey,
      ),
      manifest: Config.schema(ManifestPath, inputVariables.manifest),
      mode: Config.schema(DeployMode, inputVariables.mode),
      environment: Config.schema(EnvironmentName, inputVariables.environment),
      token: optionalInput({
        schema: Schema.RedactedFromValue(ForgeToken),
        name: inputVariables.token,
      }),
      prComment: Config.schema(PrComment, inputVariables.prComment).pipe(
        Config.withDefault('true'),
        Config.map((value) => value === 'true'),
      ),
      forge: Config.all({
        apiUrl: optionalInput({
          schema: Schema.URLFromString,
          name: inputVariables.forgeApiUrl,
        }),
        repository: optionalInput({
          schema: Repository,
          name: inputVariables.repository,
        }),
        pullRequest: optionalInput({
          schema: PullRequestNumber,
          name: inputVariables.pullRequest,
        }),
      }),
    }),
  )

  static readonly buildTestService = (shape: Partial<ActionInputsShape> = {}) =>
    ActionInputs.of({
      apiUrl: new URL('https://dokploy.example.com/api'),
      apiKey: Redacted.make('test-dokploy-api-key'),
      manifest: 'deploy/dokploy.yml',
      mode: 'plan',
      environment: 'production',
      token: Option.none(),
      prComment: true,
      forge: {
        apiUrl: Option.none(),
        repository: Option.none(),
        pullRequest: Option.none(),
      },
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    ActionInputs,
    ActionInputs.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<ActionInputsShape>,
  ): Layer.Layer<ActionInputs> =>
    Layer.succeed(ActionInputs, ActionInputs.buildTestService(shape))
}
