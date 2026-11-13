import { describe, expect, it } from '@effect/vitest'
import * as Yaml from 'effect/encoding/Yaml'

import { requiredVariables } from '#compose/compose-file.ts'

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
