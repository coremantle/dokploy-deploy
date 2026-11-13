import {
  Config,
  Context,
  Duration,
  Layer,
  Option,
  Redacted,
  Schema,
} from 'effect'

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
  deploy: 'DOKPLOY_DEPLOY_DEPLOY',
  commit: 'DOKPLOY_DEPLOY_COMMIT',
  deployTimeout: 'DOKPLOY_DEPLOY_DEPLOY_TIMEOUT',
  outputFile: 'GITHUB_OUTPUT',
} as const

export const defaultDeployTimeoutSeconds = 1800

export const testCommit = '0123456789abcdef0123456789abcdef01234567'

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

function toggle(name: string) {
  return Schema.Trim.check(
    Schema.isPattern(/^(?:true|false)$/u, {
      message: `${name} is true or false`,
    }),
  )
}

const Commit = Schema.Trim.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu, {
    message: 'a commit is a full 40- or 64-character hexadecimal sha',
  }),
)

const TimeoutSeconds = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
)

const OutputFile = Schema.Trim.check(Schema.isMinLength(1))

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
  readonly deploy: boolean
  readonly commit: Option.Option<string>
  readonly deployTimeout: Duration.Duration
  readonly outputFile: Option.Option<string>
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
      prComment: Config.schema(
        toggle('pr-comment'),
        inputVariables.prComment,
      ).pipe(
        Config.withDefault('true'),
        Config.map((value) => value === 'true'),
      ),
      deploy: Config.schema(toggle('deploy'), inputVariables.deploy).pipe(
        Config.withDefault('true'),
        Config.map((value) => value === 'true'),
      ),
      commit: optionalInput({
        schema: Commit,
        name: inputVariables.commit,
      }).pipe(Config.map(Option.map((sha) => sha.toLowerCase()))),
      deployTimeout: Config.schema(
        TimeoutSeconds,
        inputVariables.deployTimeout,
      ).pipe(
        Config.withDefault(defaultDeployTimeoutSeconds),
        Config.map((seconds) => Duration.seconds(seconds)),
      ),
      outputFile: optionalInput({
        schema: OutputFile,
        name: inputVariables.outputFile,
      }),
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
      deploy: true,
      commit: Option.some(testCommit),
      deployTimeout: Duration.seconds(defaultDeployTimeoutSeconds),
      outputFile: Option.none(),
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
