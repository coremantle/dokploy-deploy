import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
  DuplicateDomainError,
  UnknownComposeServiceError,
  desiredDomains,
  manifestHosts,
  strayRouterHosts,
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

describe('strayRouterHosts', () => {
  it('should report nothing when every router host is declared', () => {
    // Given: a router of the allow-list on a host of the manifest
    const routerHosts = [
      {
        service: 'template-storage',
        router: 'assets-methods-web',
        host: 'assets.template.example.com',
      },
    ]

    // When: comparing them with the declared hosts
    const stray = strayRouterHosts({
      routerHosts,
      declaredHosts: ['assets.template.example.com'],
    })

    // Then: nothing is reported
    expect(stray).toEqual([])
  })

  it('should report a router host that is not declared', () => {
    // Given: a router still written for the host before a rename
    const renamed = {
      service: 'template-storage',
      router: 'assets-methods-web',
      host: 'assets-old.template.example.com',
    }

    // When: comparing it with the declared hosts
    const stray = strayRouterHosts({
      routerHosts: [renamed],
      declaredHosts: ['assets.template.example.com'],
    })

    // Then: that router host is reported
    expect(stray).toEqual([renamed])
  })

  it('should report nothing for a compose without router labels', () => {
    // Given: no router host at all
    const routerHosts: ReadonlyArray<never> = []

    // When: comparing them with the declared hosts
    const stray = strayRouterHosts({
      routerHosts,
      declaredHosts: ['assets.template.example.com'],
    })

    // Then: nothing is reported
    expect(stray).toEqual([])
  })
})

describe('manifestHosts', () => {
  it('should list the hosts of every environment once', () => {
    // Given: two domains and two environments
    const domains: readonly [ManifestDomain, ...Array<ManifestDomain>] = [
      webDomain,
      { ...webDomain, subdomain: 'api' },
      { ...webDomain, path: '/v2' },
    ]
    const dokploy = { project: 'Template', environment: 'x', compose: 'web' }

    // When: listing the hosts
    const hosts = manifestHosts({
      domains,
      environments: {
        production: { dokploy, domain: 'example.com' },
        staging: { dokploy, domain: 'staging.example.com' },
      },
    })

    // Then: each host of each environment is listed once
    expect(hosts).toEqual([
      'app.example.com',
      'api.example.com',
      'app.staging.example.com',
      'api.staging.example.com',
    ])
  })
})
