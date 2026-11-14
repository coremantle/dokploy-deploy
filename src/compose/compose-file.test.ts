import { describe, expect, it } from '@effect/vitest'
import * as Yaml from 'effect/encoding/Yaml'

import { Schema } from 'effect'

import {
  ComposeDocument,
  requiredVariables,
  routerHosts,
} from '#compose/compose-file.ts'

function routerHostsOf(text: string) {
  const { services } = Schema.decodeUnknownSync(ComposeDocument)(
    Yaml.parse(text),
  )
  return routerHosts(services)
}

describe('requiredVariables', () => {
  it('should list the variables used without a default, sorted', () => {
    // Given: a compose file using every interpolation form
    const document = Yaml.parse(`
services:
  api:
    image: registry.example.com/api:\${IMAGE_TAG}
    environment:
      DATABASE_URL: $DATABASE_URL
      SMTP_HOST: \${SMTP_HOST:?SMTP_HOST is required}
      SMTP_USER: \${SMTP_USER?}
      LOG_LEVEL: \${LOG_LEVEL:-info}
      REGION: \${REGION-eu}
      DEBUG_FLAG: \${DEBUG:+--debug}
      LITERAL: $$NOT_A_VARIABLE
      FALLBACK: \${PRIMARY:-\${SECONDARY}}
    command: ["serve", "--port", "\${PORT}"]
    deploy:
      replicas: 2
`)

    // When: listing the required variables
    const variables = requiredVariables(document)

    // Then: only the ones Docker Compose would leave empty are listed
    expect(variables).toEqual([
      'DATABASE_URL',
      'IMAGE_TAG',
      'PORT',
      'SMTP_HOST',
      'SMTP_USER',
    ])
  })

  it('should list a variable used several times once', () => {
    // Given: the same variable in two services
    const document = Yaml.parse(`
services:
  web:
    environment:
      - API_URL=\${API_URL}
  worker:
    environment:
      - API_URL=\${API_URL}
`)

    // When: listing the required variables
    const variables = requiredVariables(document)

    // Then: it appears once
    expect(variables).toEqual(['API_URL'])
  })

  it('should list nothing for a compose file without interpolation', () => {
    // Given: plain values only
    const document = Yaml.parse(`
services:
  web:
    image: nginx:1.27
    ports: [80]
`)

    // When: listing the required variables
    const variables = requiredVariables(document)

    // Then: nothing is required
    expect(variables).toEqual([])
  })
})

describe('routerHosts', () => {
  it('should read the hosts of the router rules in the list syntax', () => {
    // Given: the method allow-list labels of the README on one service
    const text = `
services:
  storage:
    labels:
      - traefik.enable=true
      - traefik.http.middlewares.app-deny.ipallowlist.sourcerange=127.0.0.1/32
      - traefik.http.routers.app-methods-websecure.rule=Host(\`assets.example.com\`) && !(Method(\`GET\`) || Method(\`HEAD\`))
      - traefik.http.routers.app-methods-websecure.priority=100000
      - traefik.http.routers.app-methods-web.rule=Host(\`assets.example.com\`) && !(Method(\`GET\`) || Method(\`HEAD\`))
      - traefik.http.routers.app-methods-web.service=noop@internal
`

    // When: reading the router hosts
    const hosts = routerHostsOf(text)

    // Then: each router's host is listed, other labels are ignored
    expect(hosts).toEqual([
      {
        service: 'storage',
        router: 'app-methods-websecure',
        host: 'assets.example.com',
      },
      {
        service: 'storage',
        router: 'app-methods-web',
        host: 'assets.example.com',
      },
    ])
  })

  it('should read the hosts of the router rules in the map syntax', () => {
    // Given: labels written as a map, one rule naming two Host matchers
    const text = `
services:
  web:
    labels:
      traefik.enable: true
      traefik.http.routers.web.rule: Host(\`App.Example.com\`) || Host(\`www.example.com\`) && PathPrefix(\`/api\`)
      traefik.http.routers.web.priority: 10
`

    // When: reading the router hosts
    const hosts = routerHostsOf(text)

    // Then: both hosts are listed, lowercased like Traefik matches them
    expect(hosts).toEqual([
      { service: 'web', router: 'web', host: 'app.example.com' },
      { service: 'web', router: 'web', host: 'www.example.com' },
    ])
  })

  it('should read every host of a Traefik v2 Host matcher', () => {
    // Given: a v2 rule listing two double-quoted hosts in one lowercase host matcher
    const text = `
services:
  web:
    labels:
      - 'traefik.http.routers.legacy.rule=host("a.example.com", "b.example.com")'
`

    // When: reading the router hosts
    const hosts = routerHostsOf(text)

    // Then: both hosts are listed
    expect(hosts.map(({ host }) => host)).toEqual([
      'a.example.com',
      'b.example.com',
    ])
  })

  it('should skip what is not a Host matcher of an HTTP router rule', () => {
    // Given: regexp, SNI, negated and interpolated hosts, and labels that are no rule
    const text = `
services:
  web:
    labels:
      - traefik.http.routers.any.rule=HostRegexp(\`^.+\\\\.example\\\\.com$\`)
      - traefik.tcp.routers.db.rule=HostSNI(\`db.example.com\`)
      - traefik.http.routers.env.rule=Host(\`\${APP_HOST}\`)
      - traefik.http.routers.web.priority=Host(\`priority.example.com\`)
      - com.example.note=Host(\`note.example.com\`)
      - traefik.http.routers.not.rule=PathPrefix(\`/a\`) && ! Host(\`excluded.example.com\`)
      - not-a-key-value
  worker:
    image: worker:1
  sidecar:
    labels: [traefik.enable=true]
`

    // When: reading the router hosts
    const hosts = routerHostsOf(text)

    // Then: nothing is listed
    expect(hosts).toEqual([])
  })

  it('should read the deploy labels, a v2 HostHeader, any key case and a fully qualified host', () => {
    // Given: a stack-style service with its router under deploy.labels
    const text = `
services:
  web:
    labels:
      - traefik.http.routers.web.rule=Host(\`app.example.com.\`)
    deploy:
      labels:
        - traefik.http.routers.web.rule=Host (\`app.example.com\`)
        - traefik.http.routers.legacy.Rule=HostHeader(\`old.example.com\`)
`

    // When: reading the router hosts
    const hosts = routerHostsOf(text)

    // Then: every host is listed once, without its trailing dot
    expect(hosts).toEqual([
      { service: 'web', router: 'web', host: 'app.example.com' },
      { service: 'web', router: 'legacy', host: 'old.example.com' },
    ])
  })
})
