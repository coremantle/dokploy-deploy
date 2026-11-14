import { Array } from 'effect'

import type { DeploymentPlan } from '#deployment-planner.ts'
import type { DesiredDomain } from '#domains/desired-domains.ts'
import { hasDomainChanges, routeOf } from '#domains/domain-diff.ts'
import type { DokployDomain } from '#dokploy/dokploy-client.ts'

export function planMarker({
  environment,
  dokploy,
}: Pick<DeploymentPlan, 'environment' | 'dokploy'>): string {
  return `<!-- dokploy-deploy:plan:${environment}:${dokploy.composeId.replaceAll(/[^\w-]/gu, '')} -->`
}

function cell(text: string): string {
  return `\`${text
    .replaceAll('`', "'")
    .replaceAll('|', '\\|')
    .replaceAll(/[\r\n]/gu, ' ')}\``
}

function domainCells(domain: DesiredDomain | DokployDomain): string {
  const url = `${domain.https ? 'https' : 'http'}://${routeOf(domain)}`
  const service = `${domain.serviceName ?? '?'}:${domain.port ?? '?'}`
  return `${cell(url)} | ${cell(service)}`
}

function headline(plan: DeploymentPlan): string {
  if (plan.unsupported.length > 0) return '`apply` would refuse this manifest.'
  return hasChanges(plan)
    ? '`apply` would make the changes below.'
    : '`apply` would change nothing.'
}

export function hasChanges({ changes }: DeploymentPlan): boolean {
  return changes.env.drift || hasDomainChanges(changes.domains)
}

function envSection({ changes: { env } }: DeploymentPlan) {
  const rows = [
    ...Array.map(env.added, (key) => `| add | ${cell(key)} |`),
    ...Array.map(env.changed, (key) => `| change | ${cell(key)} |`),
    ...Array.map(env.removed, (key) => `| remove | ${cell(key)} |`),
  ]
  if (!env.drift) return ['#### Environment', '', 'No change.']
  if (rows.length === 0) {
    return [
      '#### Environment',
      '',
      'Same keys and references; the block is rewritten to its canonical form.',
    ]
  }
  return ['#### Environment', '', '| Change | Key |', '| --- | --- |', ...rows]
}

function domainsSection({ changes: { domains } }: DeploymentPlan) {
  const rows = [
    ...Array.map(
      domains.create,
      (domain) => `| create | ${domainCells(domain)} |`,
    ),
    ...Array.map(
      domains.update,
      ({ desired, fields }) =>
        `| update (${fields.join(', ')}) | ${domainCells(desired)} |`,
    ),
    ...Array.map(
      domains.delete,
      (domain) => `| delete | ${domainCells(domain)} |`,
    ),
  ]
  const unchanged =
    domains.unchanged.length === 0
      ? []
      : ['', `${domains.unchanged.length} domain(s) unchanged.`]
  if (rows.length === 0) return ['#### Domains', '', 'No change.', ...unchanged]
  return [
    '#### Domains',
    '',
    '| Change | Route | Service |',
    '| --- | --- | --- |',
    ...rows,
    ...unchanged,
  ]
}

function unsupportedSection({ unsupported }: DeploymentPlan) {
  if (unsupported.length === 0) return []
  return [
    '',
    `> [!WARNING]`,
    `> \`allowedMethods\` is set on ${Array.map(unsupported, cell).join(', ')}: Dokploy's domain API has no such setting, so \`apply\` will refuse this manifest.`,
  ]
}

function strayRouterHostsSection({ strayRouterHosts }: DeploymentPlan) {
  if (strayRouterHosts.length === 0) return []
  return [
    '',
    `> [!WARNING]`,
    `> The Traefik labels of the compose file route hosts that no environment of the manifest declares as a domain: ${Array.map(
      strayRouterHosts,
      ({ service, router, host }) =>
        `${cell(host)} (router ${cell(router)} of service ${cell(service)})`,
    ).join(
      ', ',
    )}. A router written for a renamed host no longer matches it, so its rule (an HTTP method allow-list, say) no longer applies: fix the host in the labels or in the manifest.`,
  ]
}

export function renderPlanReport(plan: DeploymentPlan): string {
  const { environment, dokploy } = plan
  return [
    planMarker(plan),
    `### Dokploy plan: \`${environment}\``,
    '',
    `Compose ${cell(dokploy.compose)} of project ${cell(dokploy.project)}, environment ${cell(dokploy.environment)}. ${headline(plan)}`,
    '',
    ...envSection(plan),
    '',
    ...domainsSection(plan),
    ...unsupportedSection(plan),
    ...strayRouterHostsSection(plan),
    '',
  ].join('\n')
}
