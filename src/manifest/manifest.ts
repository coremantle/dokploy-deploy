import { Effect, Schema } from 'effect'

const dnsLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'

const DokployName = Schema.String.check(
  Schema.isPattern(/^\S(?:[^\n\r]*\S)?$/u, {
    message: 'a Dokploy name is one line, without leading or trailing spaces',
  }),
).annotate({ description: 'A Dokploy name, as shown in the dashboard.' })

export const isEnvironmentName = Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u, {
  message:
    'an environment name is lowercase letters, digits and dashes, starting with a letter',
})

const EnvironmentName = Schema.String.check(isEnvironmentName)

const ProviderName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u, {
    message:
      'a Dokploy vault provider name is 1 to 64 letters, digits, dashes or underscores',
  }),
).annotate({
  description:
    'Name of the Dokploy vault provider that reads `secrets.folder` in this environment. Default: `infisical-<project>`, plus `-<environment>` outside production (slugs of the Dokploy names), as babel names it at onboarding.',
})

const InfisicalSecrets = Schema.Struct({ provider: ProviderName })

export const openBaoPathSegment = '[A-Za-z0-9_-][A-Za-z0-9_.-]*'

export const openBaoField = '[A-Za-z0-9_.-]+'

export const openBaoReference = `${openBaoPathSegment}(?:/${openBaoPathSegment})*:${openBaoField}`

const openBaoLiteral = String.raw`[^\x22\x27\x60$\\\p{Cc}]`

const openBaoPart = String.raw`(?:${openBaoLiteral}|\$\{${openBaoReference}\})`

const OpenBaoValue = Schema.String.check(
  Schema.isPattern(
    new RegExp(
      String.raw`^(?:${openBaoReference}|${openBaoPart}*\$\{${openBaoReference}\}${openBaoPart}*)$`,
      'u',
    ),
    {
      message:
        'an OpenBao value is a reference `<path>:<field>` (path relative to the mount, e.g. prod/postgres:password), or a text holding at least one `${<path>:<field>}` and no quote, backtick, `$` outside a reference, backslash or control character',
    },
  ),
).annotate({
  description:
    "A reference `<path>:<field>`, the path relative to the provider's mount (e.g. `prod/postgres:password`), or a composed value holding `${<path>:<field>}` references (e.g. `postgres://app:${prod/postgres:password}@db:5432/app`).",
})

export const EnvKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_.-]*$/u, {
    message:
      'an environment key is letters, digits, `_`, `.` and `-`, starting with a letter or `_`',
  }),
)

const OpenBaoEnv = Schema.Record(EnvKey, OpenBaoValue)
  .check(Schema.isMinProperties(1))
  .annotate({
    description:
      'Environment keys of the compose, each mapped to the value Dokploy resolves from this provider at deploy time.',
  })

const OpenBaoSecrets = Schema.Struct({
  openbao: Schema.Record(ProviderName, OpenBaoEnv)
    .check(Schema.isMinProperties(1))
    .annotate({
      description:
        'OpenBao (Dokploy "HashiCorp Vault / OpenBao") providers of this environment, e.g. `<app>-prod` and `shared-prod`, each with its explicit env key → reference mapping.',
    }),
})

const EnvironmentSecrets = Schema.Union([InfisicalSecrets, OpenBaoSecrets])

const SecretsFolder = Schema.String.check(
  Schema.isPattern(/^(?:\/[A-Za-z0-9_-]+)+$/u, {
    message:
      'a secrets folder is an absolute Infisical path such as /my-project, made of letters, digits, dashes and underscores',
  }),
).annotate({
  description:
    'Infisical folder the references point to: `/<project>`, a folder under it, or `/shared`.',
})

const ParentDomain = Schema.String.check(
  Schema.isPattern(
    new RegExp(`^(?=.{1,253}$)${dnsLabel}(?:\\.${dnsLabel})+$`, 'u'),
    { message: 'a domain is a lowercase DNS name such as example.com' },
  ),
).annotate({
  description:
    "Parent domain of the environment's hosts: each host is `<subdomain>.<domain>`.",
})

const Subdomain = Schema.String.check(
  Schema.isPattern(new RegExp(`^${dnsLabel}$`, 'u'), {
    message: 'a subdomain is a single lowercase DNS label',
  }),
)

const ComposeServiceName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u, {
    message:
      'a compose service name is letters, digits, dots, dashes and underscores',
  }),
).annotate({ description: 'Service of the compose file the domain routes to.' })

const RelativePath = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\n\r]+$/u, {
    message:
      'the compose path is one line, relative to the workspace, without `..`',
  }),
)

const UrlPath = Schema.String.check(
  Schema.isPattern(/^\/\S*$/u, {
    message: 'a domain path starts with / and holds no spaces',
  }),
)

const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
).annotate({ description: 'Container port the domain routes to.' })

export const HttpMethod = Schema.Literals([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
])

export type HttpMethod = typeof HttpMethod.Type

export const CertificateType = Schema.Literals([
  'letsencrypt',
  'none',
  'custom',
])

export type CertificateType = typeof CertificateType.Type

const defaultComposePath = 'docker-compose.dokploy.yml'

const ManifestDomain = Schema.Struct({
  service: ComposeServiceName,
  subdomain: Subdomain,
  port: Port,
  path: UrlPath.annotate({ default: '/' }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('/')),
  ),
  https: Schema.Boolean.annotate({ default: true }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  certificateType: CertificateType.annotate({ default: 'letsencrypt' }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('letsencrypt' as const)),
  ),
  allowedMethods: Schema.optionalKey(
    Schema.NonEmptyArray(HttpMethod).check(Schema.isUnique()),
  ),
})

const ManifestEnvironment = Schema.Struct({
  dokploy: Schema.Struct({
    project: DokployName,
    environment: DokployName,
    compose: DokployName,
  }),
  secrets: Schema.optionalKey(EnvironmentSecrets),
  domain: ParentDomain,
})

export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  composeFile: RelativePath.annotate({
    default: defaultComposePath,
    description:
      'Compose file, relative to the workspace, whose `${VAR}` without a default must all be secret keys.',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultComposePath))),
  secrets: Schema.optionalKey(Schema.Struct({ folder: SecretsFolder })),
  environments: Schema.Record(EnvironmentName, ManifestEnvironment).check(
    Schema.isMinProperties(1),
  ),
  domains: Schema.NonEmptyArray(ManifestDomain),
})
  .annotate({
    title: 'dokploy-deploy manifest',
    description:
      'Deployment manifest of an application deployed by coremantle/dokploy-deploy.',
  })
  .check(
    Schema.makeFilter(({ secrets, environments }) => {
      const infisical = Object.entries(environments)
        .filter(([, environment]) => !isOpenBao(environment))
        .map(([name]) => name)
      return secrets !== undefined || infisical.length === 0
        ? true
        : `environment(s) ${infisical.join(', ')} read Infisical (no \`secrets.openbao\`), which needs the top-level \`secrets.folder\``
    }),
  )

export type Manifest = typeof Manifest.Type

export type ManifestEnvironment = typeof ManifestEnvironment.Type

export type OpenBaoSecrets = typeof OpenBaoSecrets.Type

export function isOpenBao(
  environment: Pick<ManifestEnvironment, 'secrets'>,
): environment is { readonly secrets: OpenBaoSecrets } {
  return environment.secrets !== undefined && 'openbao' in environment.secrets
}

export type ManifestDomain = typeof ManifestDomain.Type

export const manifestParseOptions = {
  onExcessProperty: 'error',
  errors: 'all',
} as const

export function manifestJsonSchema() {
  const { schema, definitions } = Schema.toJsonSchemaDocument(Manifest, {
    onExcessProperty: 'error',
  })
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...schema,
    ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
  }
}
