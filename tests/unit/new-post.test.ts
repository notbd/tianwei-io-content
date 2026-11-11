import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newPostFile, todayInContentTimeZone } from '../../src/newPost.ts'
import { parseMdxFile } from '../../src/parser.ts'
import { makeContentDir } from '../helpers/fixture-content.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined)
    fs.rmSync(root, { recursive: true, force: true })
})

describe('todayInContentTimeZone', () => {
  it('is the date in New York, not in UTC or on this machine', () => {
    // 03:30 UTC on Nov 2 is still Nov 1 in New York
    expect(todayInContentTimeZone(new Date('2026-11-02T03:30:00Z'))).toBe('2026-11-01')
    expect(todayInContentTimeZone(new Date('2026-11-02T05:30:00Z'))).toBe('2026-11-02')
  })
})

describe('newPostFile', () => {
  it('derives the slug from the title and writes a draft the parser accepts', () => {
    const { slug, text } = newPostFile('Hello, "World": A First Post', 'Tianwei Zhang', '2026-11-01', new Set())
    expect(slug).toBe('hello-world-a-first-post')

    root = makeContentDir({ [`articles/${slug}.mdx`]: text })
    const record = parseMdxFile(path.join(root, `articles/${slug}.mdx`), root)
    expect(record).toMatchObject({
      slug,
      category: 'articles',
      title: 'Hello, "World": A First Post',
      description: null,
      author: 'Tianwei Zhang',
      updatedAt: null,
      isPublished: false,
    })
    expect(record.createdAt.toISOString()).toBe('2026-11-01T04:00:00.000Z')
  })

  it('refuses a title with nothing to build a slug from, or one too long for the slug column', () => {
    expect(() => newPostFile('???', 'A', '2026-11-01', new Set())).toThrow(/no letters or digits/)
    expect(() => newPostFile('word '.repeat(45), 'A', '2026-11-01', new Set())).toThrow(/224-character slug \(max 200\)/)
  })

  it('refuses a slug another post has, in any category', () => {
    expect(() => newPostFile('Hello World', 'A', '2026-11-01', new Set(['hello-world'])))
      .toThrow('[new-post] a post with the slug "hello-world" already exists')
  })
})
