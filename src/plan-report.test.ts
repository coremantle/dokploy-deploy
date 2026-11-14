import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import type { DeploymentPlan } from '#deployment-planner.ts'
import { DeploymentPlanner } from '#deployment-planner.ts'
import type { DesiredDomain } from '#domains/desired-domains.ts'
import { planMarker, renderPlanReport } from '#plan-report.ts'

const basePlan = Effect.runSync(DeploymentPlanner.buildTestService().plan)

const web: DesiredDomain = {
  host: 'app.demo.example.com',
  serviceName: 'web',
  port: 3000,
  path: '/',
  https: true,
  certificateType: 'letsencrypt',
}

const changedPlan: DeploymentPlan = {
  ...basePlan,
  changes: {
    env: {
      drift: true,
      added: ['GREETING'],
      changed: ['MESSAGE'],
      removed: ['LEGACY_TOKEN'],
    },
    domains: {
      create: [web],
      update: [
        {
          domainId: 'domain-api',
          desired: { ...web, host: 'api.demo.example.com', port: 4000 },
          fields: ['port'],
        },
      ],
      delete: [
        {
          domainId: 'domain-old',
          host: 'old.demo.example.com',
          path: '/',
          port: null,
          serviceName: null,
          https: false,
          certificateType: 'none',
        },
      ],
      unchanged: [],
    },
  },
}

describe('renderPlanReport', () => {
  it('should start with the marker of the environment', () => {
    // Given: a plan for production
    const plan = basePlan

    // When: rendering the report
    const report = renderPlanReport(plan)

    // Then: the comment can be found again on the next run
    expect(report.startsWith(planMarker(plan))).toBe(true)
  })

  it('should say that apply would change nothing', () => {
    // Given: a plan without changes
    const plan = basePlan

    // When: rendering the report
    const report = renderPlanReport(plan)

    // Then: both sections say no change
    expect(report).toContain('`apply` would change nothing.')
    expect(report.match(/No change\./gu)).toHaveLength(2)
  })

  it('should list every key and domain change', () => {
    // Given: a plan with changes
    const plan = changedPlan

    // When: rendering the report
    const report = renderPlanReport(plan)

    // Then: each change has its row
    expect(report).toContain('| add | `GREETING` |')
    expect(report).toContain('| change | `MESSAGE` |')
    expect(report).toContain('| remove | `LEGACY_TOKEN` |')
    expect(report).toContain(
      '| create | `https://app.demo.example.com/` | `web:3000` |',
    )
    expect(report).toContain(
      '| update (port) | `https://api.demo.example.com/` | `web:4000` |',
    )
    expect(report).toContain(
      '| delete | `http://old.demo.example.com/` | `?:?` |',
    )
  })

  it('should keep a hostile name from breaking out of its cell', () => {
    // Given: a key name read back from Dokploy with markdown in it
    const plan: DeploymentPlan = {
      ...changedPlan,
      changes: {
        ...changedPlan.changes,
        env: { drift: true, added: [], changed: [], removed: ['A|`<b>`'] },
      },
    }

    // When: rendering the report
    const report = renderPlanReport(plan)

    // Then: the pipe is escaped and the backticks neutralised
    expect(report).toContain("| remove | `A\\|'<b>'` |")
  })

  it('should warn that apply refuses allowedMethods', () => {
    // Given: a domain restricting its methods
    const plan: DeploymentPlan = {
      ...basePlan,
      unsupported: ['app.demo.example.com/'],
    }

    // When: rendering the report
    const report = renderPlanReport(plan)

    // Then: the warning names the route
    expect(report).toContain(
      '`allowedMethods` is set on `app.demo.example.com/`',
    )
    expect(report).toContain('`apply` would refuse this manifest.')
  })

  it('should warn about router hosts that are not domains', () => {
    // Given: an allow-list router left on a renamed host
    const plan: DeploymentPlan = {
      ...basePlan,
      strayRouterHosts: [
        {
          service: 'storage',
          router: 'assets-methods-web',
          host: 'assets-old.demo.example.com',
        },
      ],
    }

    // When: rendering the report
    const report = renderPlanReport(plan)

    // Then: the warning names the host, the router and the service, and apply is not refused
    expect(report).toContain(
      'route hosts that no environment of the manifest declares as a domain: `assets-old.demo.example.com` (router `assets-methods-web` of service `storage`)',
    )
    expect(report).toContain('`apply` would change nothing.')
  })

  it('should not warn when every router host is a domain', () => {
    // Given: a plan without stray router hosts
    const plan = basePlan

    // When: rendering the report
    const report = renderPlanReport(plan)

    // Then: there is no warning
    expect(report).not.toContain('[!WARNING]')
  })
})
