import { Array, Option, pipe } from 'effect'

import type { DesiredDomain } from '#domains/desired-domains.ts'
import type { DokployDomain, DomainSettings } from '#dokploy/dokploy-client.ts'

export type DomainField = 'serviceName' | 'port' | 'https' | 'certificateType'

export interface DomainUpdate {
  readonly domainId: string
  readonly desired: DesiredDomain
  readonly fields: ReadonlyArray<DomainField>
}

export interface DomainDiff {
  readonly create: ReadonlyArray<DesiredDomain>
  readonly update: ReadonlyArray<DomainUpdate>
  readonly delete: ReadonlyArray<DokployDomain>
  readonly unchanged: ReadonlyArray<DesiredDomain>
}

const comparedFields: ReadonlyArray<DomainField> = [
  'serviceName',
  'port',
  'https',
  'certificateType',
]

export function routeOf({
  host,
  path,
}: {
  readonly host: string
  readonly path: string | null
}): string {
  return `${host}${path ?? '/'}`
}

export function domainLine({
  https,
  host,
  path,
  serviceName,
  port,
}: {
  readonly https: boolean
  readonly host: string
  readonly path: string | null
  readonly serviceName: string | null
  readonly port: number | null
}): string {
  return `${https ? 'https' : 'http'}://${routeOf({ host, path })} -> ${serviceName ?? '?'}:${port ?? '?'}`
}

export function domainSettings(domain: DesiredDomain): DomainSettings {
  const { host, path, port, serviceName, https, certificateType } = domain
  return { host, path, port, serviceName, https, certificateType }
}

function changedFields({
  desired,
  current,
}: {
  readonly desired: DesiredDomain
  readonly current: DokployDomain
}) {
  return Array.filter(
    comparedFields,
    (field) => desired[field] !== current[field],
  )
}

export function diffDomains({
  current,
  desired,
}: {
  readonly current: ReadonlyArray<DokployDomain>
  readonly desired: ReadonlyArray<DesiredDomain>
}): DomainDiff {
  const matches = Array.map(desired, (domain) => ({
    domain,
    match: Array.findFirst(
      current,
      (candidate) => routeOf(candidate) === routeOf(domain),
    ),
  }))
  const matchedIds = new Set(
    Array.flatMap(matches, ({ match }) =>
      Option.isSome(match) ? [match.value.domainId] : [],
    ),
  )
  const compared = Array.flatMap(matches, ({ domain, match }) =>
    Option.isSome(match)
      ? [
          {
            domainId: match.value.domainId,
            desired: domain,
            fields: changedFields({ desired: domain, current: match.value }),
          },
        ]
      : [],
  )
  return {
    create: pipe(
      matches,
      Array.filter(({ match }) => Option.isNone(match)),
      Array.map(({ domain }) => domain),
    ),
    update: Array.filter(compared, ({ fields }) => fields.length > 0),
    delete: Array.filter(current, ({ domainId }) => !matchedIds.has(domainId)),
    unchanged: pipe(
      compared,
      Array.filter(({ fields }) => fields.length === 0),
      Array.map(({ desired: domain }) => domain),
    ),
  }
}

export function hasDomainChanges(diff: DomainDiff): boolean {
  return (
    diff.create.length > 0 || diff.update.length > 0 || diff.delete.length > 0
  )
}
