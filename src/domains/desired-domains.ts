import { Array, Effect, Record, Schema, pipe } from 'effect'

import type { RouterHost } from '#compose/compose-file.ts'
import { routeOf } from '#domains/domain-diff.ts'
import type {
  CertificateType,
  HttpMethod,
  Manifest,
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

export class UnsupportedAllowedMethodsError extends Schema.TaggedError<UnsupportedAllowedMethodsError>()(
  'UnsupportedAllowedMethodsError',
  { routes: Schema.Array(Schema.String), message: Schema.String },
) {
  static forRoutes(
    routes: ReadonlyArray<string>,
  ): UnsupportedAllowedMethodsError {
    return new UnsupportedAllowedMethodsError({
      routes,
      message: `domains[].allowedMethods is set on ${routes.join(', ')}, but Dokploy's domain API has no such setting: apply cannot enforce it, so it changed nothing; remove allowedMethods from the manifest`,
    })
  }
}

export function routesWithAllowedMethods(
  domains: ReadonlyArray<DesiredDomain>,
): ReadonlyArray<string> {
  return pipe(
    domains,
    Array.filter(({ allowedMethods }) => allowedMethods !== undefined),
    Array.map(routeOf),
  )
}

export function strayRouterHosts({
  routerHosts,
  declaredHosts,
}: {
  readonly routerHosts: ReadonlyArray<RouterHost>
  readonly declaredHosts: ReadonlyArray<string>
}): ReadonlyArray<RouterHost> {
  const hosts = new Set(declaredHosts)
  return Array.filter(routerHosts, ({ host }) => !hosts.has(host))
}

function hostOf({
  subdomain,
  parentDomain,
}: {
  readonly subdomain: string
  readonly parentDomain: string
}): string {
  return `${subdomain}.${parentDomain}`
}

export function manifestHosts({
  domains,
  environments,
}: Pick<Manifest, 'domains' | 'environments'>): ReadonlyArray<string> {
  return pipe(
    Record.values(environments),
    Array.flatMap(({ domain: parentDomain }) =>
      Array.map(domains, ({ subdomain }) =>
        hostOf({ subdomain, parentDomain }),
      ),
    ),
    Array.dedupe,
  )
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
    host: hostOf({ subdomain, parentDomain }),
    serviceName: service,
    ...routing,
    ...(allowedMethods === undefined ? {} : { allowedMethods }),
  }
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
