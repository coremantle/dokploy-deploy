import { Array, Effect, Schema, pipe } from 'effect'

import type {
  CertificateType,
  HttpMethod,
  ManifestDomain,
} from '#manifest/manifest.ts'

export interface DesiredDomain {
  readonly host: string
  readonly serviceName: string
  readonly port: number
  readonly path: string
  readonly https: boolean
  readonly certificateType: CertificateType
  readonly allowedMethods?: ReadonlyArray<HttpMethod>
}

export class UnknownComposeServiceError extends Schema.TaggedError<UnknownComposeServiceError>()(
  'UnknownComposeServiceError',
  {
    compose: Schema.String,
    services: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {
  static forServices({
    compose,
    services,
  }: {
    readonly compose: string
    readonly services: ReadonlyArray<string>
  }): UnknownComposeServiceError {
    return new UnknownComposeServiceError({
      compose,
      services,
      message: `the manifest routes domains to ${services.join(', ')}, which ${compose} does not define`,
    })
  }
}

export class DuplicateDomainError extends Schema.TaggedError<DuplicateDomainError>()(
  'DuplicateDomainError',
  { routes: Schema.Array(Schema.String), message: Schema.String },
) {
  static forRoutes(routes: ReadonlyArray<string>): DuplicateDomainError {
    return new DuplicateDomainError({
      routes,
      message: `the manifest declares ${routes.join(', ')} more than once`,
    })
  }
}

function desiredDomain({
  domain,
  parentDomain,
}: {
  readonly domain: ManifestDomain
  readonly parentDomain: string
}): DesiredDomain {
  const { service, subdomain, allowedMethods, ...routing } = domain
  return {
    host: `${subdomain}.${parentDomain}`,
    serviceName: service,
    ...routing,
    ...(allowedMethods === undefined ? {} : { allowedMethods }),
  }
}

function routeOf({ host, path }: DesiredDomain) {
  return `${host}${path}`
}

function duplicatedRoutes(domains: ReadonlyArray<DesiredDomain>) {
  const routes = Array.map(domains, routeOf)
  return pipe(
    routes,
    Array.filter((route, index) => routes.indexOf(route) !== index),
    Array.dedupe,
  )
}

export function desiredDomains({
  domains,
  parentDomain,
  compose,
  services,
}: {
  readonly domains: ReadonlyArray<ManifestDomain>
  readonly parentDomain: string
  readonly compose: string
  readonly services: ReadonlyArray<string>
}) {
  const desired = Array.map(domains, (domain) =>
    desiredDomain({ domain, parentDomain }),
  )
  const unknownServices = pipe(
    desired,
    Array.map(({ serviceName }) => serviceName),
    Array.filter((serviceName) => !services.includes(serviceName)),
    Array.dedupe,
  )
  const duplicates = duplicatedRoutes(desired)
  return pipe(
    Effect.succeed(desired),
    Effect.filterOrFail(
      () => Array.isReadonlyArrayEmpty(unknownServices),
      () =>
        UnknownComposeServiceError.forServices({
          compose,
          services: unknownServices,
        }),
    ),
    Effect.filterOrFail(
      () => Array.isReadonlyArrayEmpty(duplicates),
      () => DuplicateDomainError.forRoutes(duplicates),
    ),
    Effect.withSpan('DesiredDomains.desiredDomains', {
      attributes: { parentDomain },
    }),
  )
}
