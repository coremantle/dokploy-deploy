import { Config, Context, Layer, Redacted, Schema } from 'effect'

import { DeployMode } from '#deploy-mode.ts'

export const inputVariables = {
  apiUrl: 'DOKPLOY_DEPLOY_API_URL',
  apiKey: 'DOKPLOY_DEPLOY_API_KEY',
  manifest: 'DOKPLOY_DEPLOY_MANIFEST',
  mode: 'DOKPLOY_DEPLOY_MODE',
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

const HttpsUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === 'https:', {
    message: 'the Dokploy API is only called over https',
  }),
)

export interface ActionInputsShape {
  readonly apiUrl: URL
  readonly apiKey: Redacted.Redacted<string>
  readonly manifest: string
  readonly mode: DeployMode
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
    }),
  )

  static readonly buildTestService = (shape: Partial<ActionInputsShape> = {}) =>
    ActionInputs.of({
      apiUrl: new URL('https://dokploy.example.com/api'),
      apiKey: Redacted.make('test-dokploy-api-key'),
      manifest: 'deploy/dokploy.yml',
      mode: 'plan',
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
