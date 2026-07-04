import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAllPosts, parseMdxFile } from '../../src/parser.ts'
import { makeContentDir, mdxDoc } from '../helpers/fixture-content.ts'

let root: string

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('parseMdxFile', () => {
  it('parses a valid file into a complete ContentRecord', () => {
    root = makeContentDir({
      'articles/hello-world.mdx': mdxDoc({
        title: 'Hello World',
        description: 'First post',
        createdAt: '2025-10-23',
        author: 'Tianwei Zhang',
        isPublished: true,
        body: '# Heading\n\nBody text.\n',
      }),
    })

    const record = parseMdxFile(path.join(root, 'articles/hello-world.mdx'), root)
    expect(record).toEqual({
      slug: 'hello-world',
      category: 'articles',
      title: 'Hello World',
      description: 'First post',
      author: 'Tianwei Zhang',
      // midnight in the content time zone (EDT in October)
      createdAt: new Date(Date.UTC(2025, 9, 23, 4)),
      isPublished: true,
      // gray-matter preserves one leading newline after the frontmatter block
      content: '\n# Heading\n\nBody text.\n',
    })
  })

  it('parses unquoted YAML dates (js-yaml Date instances) to content-zone midnight', () => {
    // Unquoted `createdAt: 2025-10-23` is parsed by js-yaml as a UTC Date —
    // this is the format the real content files use. The parser re-anchors
    // the calendar date to the content time zone.
    root = makeContentDir({ 'articles/a.mdx': mdxDoc({ createdAt: '2025-10-23' }) })
    const record = parseMdxFile(path.join(root, 'articles/a.mdx'), root)
    expect(record.createdAt.getTime()).toBe(Date.UTC(2025, 9, 23, 4))
  })

  it('treats description as optional', () => {
    root = makeContentDir({ 'articles/a.mdx': mdxDoc({ description: undefined }) })
    const record = parseMdxFile(path.join(root, 'articles/a.mdx'), root)
    expect(record.description).toBeUndefined()
  })

  it('treats updatedAt as optional and parses it as UTC midnight', () => {
    root = makeContentDir({ 'articles/a.mdx': mdxDoc() })
    expect(parseMdxFile(path.join(root, 'articles/a.mdx'), root).updatedAt).toBeUndefined()

    fs.writeFileSync(
      path.join(root, 'articles/a.mdx'),
      mdxDoc({ createdAt: '2024-06-15', updatedAt: '2024-07-01' }),
    )
    const record = parseMdxFile(path.join(root, 'articles/a.mdx'), root)
    expect(record.updatedAt?.getTime()).toBe(Date.UTC(2024, 6, 1, 4))
  })

  it('rejects an updatedAt earlier than createdAt', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({ createdAt: '2024-06-15', updatedAt: '2024-06-14' }),
    })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/updatedAt: must not be before createdAt/)
  })

  it('rejects a malformed updatedAt', () => {
    root = makeContentDir({ 'articles/a.mdx': mdxDoc({ updatedAt: '\'01-07-2024\'' }) })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/updatedAt:.*Invalid date format/)
  })

  it('rejects a missing title', () => {
    root = makeContentDir({ 'articles/a.mdx': mdxDoc({ title: undefined }) })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/title: expected a non-empty string/)
  })

  it('rejects a non-boolean isPublished', () => {
    root = makeContentDir({ 'articles/a.mdx': mdxDoc({ isPublished: 'yes' }) })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/isPublished: expected a boolean/)
  })

  it('aggregates every invalid field into one error', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({
        title: undefined,
        author: undefined,
        createdAt: 'not-a-date',
        isPublished: undefined,
      }),
    })
    const run = () => parseMdxFile(path.join(root, 'articles/a.mdx'), root)
    expect(run).toThrow(/title/)
    expect(run).toThrow(/author/)
    expect(run).toThrow(/createdAt/)
    expect(run).toThrow(/isPublished/)
  })

  it('throws on structurally invalid paths', () => {
    root = makeContentDir({ 'floating.mdx': mdxDoc() })
    expect(() => parseMdxFile(path.join(root, 'floating.mdx'), root))
      .toThrow(/Invalid content path/)
  })
})

describe('parseAllPosts', () => {
  it('returns every valid record across categories', () => {
    root = makeContentDir({
      'articles/one.mdx': mdxDoc({ title: 'One' }),
      'articles/two.mdx': mdxDoc({ title: 'Two' }),
      'notes/three.mdx': mdxDoc({ title: 'Three' }),
    })
    const records = parseAllPosts(root)
    expect(records.map(record => record.slug).sort()).toEqual(['one', 'three', 'two'])
  })

  it('returns [] for a missing content root', () => {
    root = makeContentDir({})
    expect(parseAllPosts(path.join(root, 'does-not-exist'))).toEqual([])
  })

  it('fails fast when ANY file is invalid, listing each failure', () => {
    root = makeContentDir({
      'articles/good.mdx': mdxDoc(),
      'articles/bad-one.mdx': mdxDoc({ title: undefined }),
      // quoted so YAML keeps it a string and our impossible-date check fires
      'articles/bad-two.mdx': mdxDoc({ createdAt: '\'2024-02-30\'' }),
    })
    const run = () => parseAllPosts(root)
    expect(run).toThrow(/2 file\(s\) failed to parse/)
    expect(run).toThrow(/bad-one/)
    expect(run).toThrow(/bad-two/)
  })

  it('documents YAML rollover: unquoted impossible dates become valid Dates upstream', () => {
    // js-yaml parses unquoted `2024-02-30` with Date semantics, rolling it
    // over to March 1 BEFORE our validation can see the original text.
    // Nothing to catch here — the parsed value is a legitimate midnight-UTC
    // Date. Quote the frontmatter value to get strict validation.
    root = makeContentDir({ 'articles/rollover.mdx': mdxDoc({ createdAt: '2024-02-30' }) })
    const [record] = parseAllPosts(root)
    expect(record!.createdAt.getTime()).toBe(Date.UTC(2024, 2, 1, 5))
  })

  it('rejects duplicate slugs across categories', () => {
    root = makeContentDir({
      'articles/same-name.mdx': mdxDoc(),
      'notes/same-name.mdx': mdxDoc(),
    })
    expect(() => parseAllPosts(root)).toThrow(/Duplicate slugs found: "same-name"/)
  })

  it('ignores non-mdx files', () => {
    root = makeContentDir({
      'articles/post.mdx': mdxDoc(),
      'articles/notes.txt': 'not content',
      'articles/.DS_Store': 'junk',
    })
    expect(parseAllPosts(root)).toHaveLength(1)
  })
})
