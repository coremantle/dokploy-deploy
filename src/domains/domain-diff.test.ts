import { describe, expect, it } from '@effect/vitest'

import type { DesiredDomain } from '#domains/desired-domains.ts'
import { diffDomains, hasDomainChanges } from '#domains/domain-diff.ts'
import type { DokployDomain } from '#dokploy/dokploy-client.ts'

const web: DesiredDomain = {
  host: 'app.demo.example.com',
  serviceName: 'web',
  port: 3000,
  path: '/',
  https: true,
  certificateType: 'letsencrypt',
}

const api: DesiredDomain = { ...web, host: 'api.demo.example.com', port: 4000 }

function inDokploy(domain: DesiredDomain, domainId: string): DokployDomain {
  return {
    domainId,
    host: domain.host,
    path: domain.path,
    port: domain.port,
    serviceName: domain.serviceName,
    https: domain.https,
    certificateType: domain.certificateType,
  }
}

describe('diffDomains', () => {
  it('should find nothing to do when Dokploy matches the manifest', () => {
    // Given: both domains already in Dokploy
    const current = [inDokploy(web, 'domain-web'), inDokploy(api, 'domain-api')]

    // When: diffing
    const diff = diffDomains({ current, desired: [web, api] })

    // Then: both are unchanged
    expect(hasDomainChanges(diff)).toBe(false)
    expect(diff.unchanged).toEqual([web, api])
  })

  it('should create, update and delete to converge on the manifest', () => {
    // Given: web on the wrong port, api missing, and a domain the manifest dropped
    const current = [
      { ...inDokploy(web, 'domain-web'), port: 8080 },
      inDokploy(
        { ...web, host: 'old.demo.example.com', serviceName: 'old' },
        'domain-old',
      ),
    ]

    // When: diffing
    const diff = diffDomains({ current, desired: [web, api] })

    // Then: each change is planned once
    expect(diff.create).toEqual([api])
    expect(diff.update).toEqual([
      { domainId: 'domain-web', desired: web, fields: ['port'] },
    ])
    expect(diff.delete.map(({ domainId }) => domainId)).toEqual(['domain-old'])
    expect(diff.unchanged).toEqual([])
  })

  it('should match a domain whose path Dokploy left empty to the root path', () => {
    // Given: a domain stored without path
    const current = [{ ...inDokploy(web, 'domain-web'), path: null }]

    // When: diffing
    const diff = diffDomains({ current, desired: [web] })

    // Then: it is the same route
    expect(hasDomainChanges(diff)).toBe(false)
  })

  it('should delete the duplicates of a route', () => {
    // Given: the same route twice in Dokploy
    const current = [
      inDokploy(web, 'domain-web'),
      inDokploy(web, 'domain-copy'),
    ]

    // When: diffing
    const diff = diffDomains({ current, desired: [web] })

    // Then: the first one is kept, the copy deleted
    expect(diff.unchanged).toEqual([web])
    expect(diff.delete.map(({ domainId }) => domainId)).toEqual(['domain-copy'])
  })

  it('should update a domain served over another scheme or certificate', () => {
    // Given: web served over http in Dokploy
    const current = [
      {
        ...inDokploy(web, 'domain-web'),
        https: false,
        certificateType: 'none',
      },
    ]

    // When: diffing
    const diff = diffDomains({ current, desired: [web] })

    // Then: both fields are named
    expect(diff.update[0]?.fields).toEqual(['https', 'certificateType'])
  })
})
