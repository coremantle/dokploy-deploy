import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'

import {
  DuplicateDomainError,
  UnknownComposeServiceError,
  desiredDomains,
} from '#domains/desired-domains.ts'
import type { ManifestDomain } from '#manifest/manifest.ts'

const webDomain: ManifestDomain = {
  service: 'template-web',
  subdomain: 'app',
  port: 3001,
  path: '/',
  https: true,
  certificateType: 'letsencrypt',
}

const services = ['template-api', 'template-web']

describe('desiredDomains', () => {
  effect('should build each host under the environment domain', () =>
    Effect.gen(function* () {
      // Given: two domains, one restricted to some methods
      const domains: ReadonlyArray<ManifestDomain> = [
        webDomain,
        {
          ...webDomain,
          service: 'template-api',
          subdomain: 'api',
          port: 4000,
          allowedMethods: ['GET'],
        },
      ]

      // When: building the desired domains
      const desired = yield* desiredDomains({
        domains,
        services,
        parentDomain: 'template.example.com',
        compose: 'docker-compose.dokploy.yml',
      })

      // Then: hosts are subdomains of the parent and options are kept
      expect(desired).toEqual([
        {
          host: 'app.template.example.com',
          serviceName: 'template-web',
          port: 3001,
          path: '/',
          https: true,
          certificateType: 'letsencrypt',
        },
        {
          host: 'api.template.example.com',
          serviceName: 'template-api',
          port: 4000,
          path: '/',
          https: true,
          certificateType: 'letsencrypt',
          allowedMethods: ['GET'],
        },
      ])
    }),
  )

  effect('should refuse a domain routed to a service the compose lacks', () =>
    Effect.gen(function* () {
      // Given: a domain naming a service missing from the compose file
      const domains = [{ ...webDomain, service: 'template-admin' }]

      // When: building the desired domains
      const error = yield* Effect.flip(
        desiredDomains({
          domains,
          services,
          parentDomain: 'template.example.com',
          compose: 'docker-compose.dokploy.yml',
        }),
      )

      // Then: the action fails naming the service
      expect(error).toEqual(
        UnknownComposeServiceError.forServices({
          compose: 'docker-compose.dokploy.yml',
          services: ['template-admin'],
        }),
      )
    }),
  )

  effect('should refuse the same host and path declared twice', () =>
    Effect.gen(function* () {
      // Given: two domains on the same route
      const domains = [webDomain, { ...webDomain, port: 3002 }]

      // When: building the desired domains
      const error = yield* Effect.flip(
        desiredDomains({
          domains,
          services,
          parentDomain: 'template.example.com',
          compose: 'docker-compose.dokploy.yml',
        }),
      )

      // Then: the route is named
      expect(error).toEqual(
        DuplicateDomainError.forRoutes(['app.template.example.com/']),
      )
    }),
  )
})
