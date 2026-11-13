import { describe, expect, it } from '@effect/vitest'

import { escapeCommandData } from '#workflow-commands.ts'

describe('escapeCommandData', () => {
  it('should escape what the runner would read as the end of the command', () => {
    // Given: a value holding a percent sign and line breaks
    const value = 'a%b\r\nc'

    // When: escaping it for a workflow command
    const escaped = escapeCommandData(value)

    // Then: the runner reads it back as one value on one line
    expect(escaped).toBe('a%25b%0D%0Ac')
  })
})
