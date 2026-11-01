import { Buffer } from 'node:buffer'
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

  it('parses unquoted YAML dates to content-zone midnight', () => {
    // Unquoted `createdAt: 2025-10-23` is the format the real content files
    // use; it reaches the date parser as the authored text, not as a
    // js-yaml Date.
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({ createdAt: '2025-10-23' }),
    })
    const record = parseMdxFile(path.join(root, 'articles/a.mdx'), root)
    expect(record.createdAt.getTime()).toBe(Date.UTC(2025, 9, 23, 4))
  })

  it('treats description as optional', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({ description: undefined }),
    })
    const record = parseMdxFile(path.join(root, 'articles/a.mdx'), root)
    expect(record.description).toBeUndefined()
  })

  it('treats updatedAt as optional and anchors it to content-zone midnight', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc(),
    })
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
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({ updatedAt: '\'01-07-2024\'' }),
    })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/updatedAt:.*Invalid date format/)
  })

  it('rejects a YAML timestamp instead of truncating it to a date', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({ createdAt: '2024-01-05 23:00:00-05:00' }),
    })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/createdAt:.*Invalid date format/)
  })

  it('rejects a missing title', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({ title: undefined }),
    })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/title: expected a non-empty string/)
  })

  it('rejects a non-boolean isPublished', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({ isPublished: 'yes' }),
    })
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
    root = makeContentDir({
      'floating.mdx': mdxDoc(),
    })
    expect(() => parseMdxFile(path.join(root, 'floating.mdx'), root))
      .toThrow(/Invalid content path/)
  })

  it('names the file when the YAML itself is malformed', () => {
    root = makeContentDir({ 'articles/broken.mdx': '---\ntitle: [unclosed\n---\nBody\n' })
    expect(() => parseMdxFile(path.join(root, 'articles/broken.mdx'), root))
      .toThrow(/Invalid frontmatter YAML in ".*broken\.mdx"/)
  })

  it('rejects an over-long author (varchar limit)', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc({
        author: 'a'.repeat(120),
      }),
    })
    expect(() => parseMdxFile(path.join(root, 'articles/a.mdx'), root))
      .toThrow(/author: exceeds 100 characters/)
  })

  it('rejects files containing invalid UTF-8 replacement characters', () => {
    root = makeContentDir({
      'articles/a.mdx': mdxDoc(),
    })
    // simulate a Latin-1 file: write raw bytes that are invalid UTF-8
    fs.writeFileSync(path.join(root, 'articles/latin1.mdx'), Buffer.from([0x2D, 0x2D, 0x2D, 0x0A, 0xE9, 0x0A]))
    expect(() => parseMdxFile(path.join(root, 'articles/latin1.mdx'), root))
      .toThrow(/invalid UTF-8/)
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
      'articles/bad-two.mdx': mdxDoc({ createdAt: '2024-02-30' }),
    })
    const run = () => parseAllPosts(root)
    expect(run).toThrow(/2 file\(s\) failed to parse/)
    expect(run).toThrow(/bad-one/)
    expect(run).toThrow(/bad-two/)
  })

  it('rejects unquoted impossible dates instead of letting YAML roll them over', () => {
    // js-yaml's timestamp type would turn `2024-02-30` into March 1 before
    // validation; frontmatter is loaded without it, so the authored text
    // reaches the calendar check and the sync aborts.
    root = makeContentDir({
      'articles/rollover.mdx': mdxDoc({ createdAt: '2024-02-30' }),
    })
    expect(() => parseAllPosts(root)).toThrow(/createdAt:.*Impossible calendar date '2024-02-30'/)
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
