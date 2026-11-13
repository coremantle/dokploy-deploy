import { describe, expect, it } from '@effect/vitest'

import { diffEnv, envEntries } from '#env/env-diff.ts'

const desired = [
  "GREETING='${{vault.infisical-demo./demo:GREETING}}'",
  "MESSAGE='${{vault.infisical-demo./demo:MESSAGE}}'",
  '',
].join('\n')

describe('diffEnv', () => {
  it('should report no drift when Dokploy holds the same block', () => {
    // Given: the block the action wrote last time
    const current = desired

    // When: diffing
    const diff = diffEnv({ current, desired })

    // Then: there is nothing to write
    expect(diff).toEqual({ drift: false, added: [], removed: [], changed: [] })
  })

  it('should name added, changed and removed keys, never their values', () => {
    // Given: a block typed by hand, with a literal secret value
    const current = [
      'MESSAGE=hunter2',
      'LEGACY_TOKEN=super-secret-value',
      '',
    ].join('\n')

    // When: diffing
    const diff = diffEnv({ current, desired })

    // Then: only key names come out
    expect(diff).toEqual({
      drift: true,
      added: ['GREETING'],
      removed: ['LEGACY_TOKEN'],
      changed: ['MESSAGE'],
    })
    expect(JSON.stringify(diff)).not.toContain('hunter2')
    expect(JSON.stringify(diff)).not.toContain('super-secret-value')
  })

  it('should never read a line of a multi-line value as a key', () => {
    // Given: hand-typed multi-line quoted values whose lines hold '='
    const current = [
      'CERT="-----BEGIN CERTIFICATE-----',
      'abcd==',
      'postgres://u:pass@h/db?sslmode=require',
      '-----END CERTIFICATE-----"',
      "JSON='{",
      '  "url=": "secret=value"',
      "}'",
      'MESSAGE=hunter2',
      '',
    ].join('\n')

    // When: diffing
    const diff = diffEnv({ current, desired })

    // Then: only the real keys are named
    expect(diff.removed).toEqual(['CERT', 'JSON'])
    expect(diff.changed).toEqual(['MESSAGE'])
    expect(JSON.stringify(diff)).not.toContain('abcd')
    expect(JSON.stringify(diff)).not.toContain('pass')
  })

  it('should read the keys after a quoted value with an inline comment', () => {
    // Given: a quoted value followed by a comment
    const current = 'FOO="bar" # note\nLEGACY=1\nOTHER=2\n'

    // When: diffing
    const diff = diffEnv({ current, desired })

    // Then: every key is still seen
    expect(diff.removed).toEqual(['FOO', 'LEGACY', 'OTHER'])
  })

  it('should report a drift without key changes when only the layout differs', () => {
    // Given: the same assignments with a comment and no trailing newline
    const current = `# set by hand\n${desired.trimEnd()}`

    // When: diffing
    const diff = diffEnv({ current, desired })

    // Then: the block is rewritten though no key changes
    expect(diff).toEqual({ drift: true, added: [], removed: [], changed: [] })
  })

  it('should treat an empty Dokploy env as every key added', () => {
    // Given: a compose without env
    const current = ''

    // When: diffing
    const diff = diffEnv({ current, desired })

    // Then: every desired key is added
    expect(diff.added).toEqual(['GREETING', 'MESSAGE'])
  })
})

describe('envEntries', () => {
  it('should read export prefixes and skip comments and blank lines', () => {
    // Given: a hand-written dotenv block
    const env = '# comment\n\nexport A=1\nB = two\nnot an assignment\n'

    // When: reading its entries
    const entries = envEntries(env)

    // Then: only the assignments are kept
    expect([...entries.keys()]).toEqual(['A', 'B'])
  })
})
