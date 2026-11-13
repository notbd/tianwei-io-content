import { describe, expect, it } from 'vitest'
import { parseAllPosts } from '../../src/parser.ts'

// The deploy parses content/ only after a merge to main, so without this an
// invalid frontmatter field would pass the pull request and fail the
// production deploy instead.
describe('committed content', () => {
  it('parses without errors, with unique slugs', () => {
    const records = parseAllPosts()
    expect(records.length).toBeGreaterThan(0)
  })
})
