import { describe, expect, it } from 'vitest'
import { messageOf } from '../../src/errors.ts'

describe('messageOf', () => {
  it('appends the messages of the causes, innermost last', () => {
    const err = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED', { cause: 'refused' }),
    })
    expect(messageOf(err)).toBe('fetch failed (connect ECONNREFUSED (refused))')
  })

  it('stops at a cause that loops back', () => {
    const outer = new Error('outer')
    const inner = new Error('inner', { cause: outer })
    outer.cause = inner
    expect(messageOf(outer)).toBe('outer (inner)')
  })
})
