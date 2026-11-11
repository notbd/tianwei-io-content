import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAllPosts, parseMdxFile } from '../../src/parser.ts'
import { makeContentDir, mdxDoc } from '../helpers/fixture-content.ts'

let root = '' // '' = not created yet

afterEach(() => {
  if (root !== '')
    fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

/** Parse `doc` as articles/a.mdx in this test's content directory. */
function parseDoc(doc: string) {
  if (root === '')
    root = makeContentDir({})
  fs.mkdirSync(path.join(root, 'articles'), { recursive: true })
  fs.writeFileSync(path.join(root, 'articles/a.mdx'), doc)
  return parseMdxFile(path.join(root, 'articles/a.mdx'), root)
}

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
      updatedAt: null,
      isPublished: true,
      // gray-matter preserves one leading newline after the frontmatter block
      content: '\n# Heading\n\nBody text.\n',
    })
  })

  it('treats description as optional', () => {
    const record = parseDoc(mdxDoc({ description: undefined }))
    expect(record.description).toBeNull()
  })

  it('treats updatedAt as optional and anchors it to content-zone midnight', () => {
    expect(parseDoc(mdxDoc()).updatedAt).toBeNull()
    const record = parseDoc(mdxDoc({ createdAt: '2024-06-15', updatedAt: '2024-07-01' }))
    expect(record.updatedAt?.getTime()).toBe(Date.UTC(2024, 6, 1, 4))
  })

  it('rejects an updatedAt earlier than createdAt', () => {
    expect(() => parseDoc(mdxDoc({ createdAt: '2024-06-15', updatedAt: '2024-06-14' })))
      .toThrow(/updatedAt: must not be before createdAt/)
  })

  it('rejects a malformed updatedAt', () => {
    expect(() => parseDoc(mdxDoc({ updatedAt: '\'01-07-2024\'' })))
      .toThrow(/updatedAt:.*Invalid date format/)
  })

  it('rejects a YAML timestamp instead of truncating it to a date', () => {
    expect(() => parseDoc(mdxDoc({ createdAt: '2024-01-05 23:00:00-05:00' })))
      .toThrow(/createdAt:.*Invalid date format/)
  })

  it.each([
    ['a control character', '"Tab\\tis fine, vertical tab\\v is not"'],
    ['U+FFFE', '"Bad\\uFFFEtitle"'],
    ['U+FFFF', '"Bad\\uFFFFtitle"'],
    ['a lone surrogate', '"Half \\uD83D of an emoji"'],
    ['NUL', '"A\\0B"'],
  ])('rejects %s in the title and description (it would break the RSS feed)', (_name, text) => {
    // YAML escapes: js-yaml already refuses raw control characters in the file
    const run = () => parseDoc(mdxDoc({ title: text, description: text }))
    expect(run).toThrow(/title: contains a character XML 1.0 forbids/)
    expect(run).toThrow(/description: contains a character XML 1.0 forbids/)
  })

  it('accepts emoji and CJK in the title (outside the BMP is still XML text)', () => {
    expect(parseDoc(mdxDoc({ title: '"标题 🚀 café"' })).title).toBe('标题 🚀 café')
  })

  it('rejects NUL in the author and the body (the database cannot store it)', () => {
    const run = () => parseDoc(mdxDoc({ author: '"A\\0B"', body: 'Before\0after.\n' }))
    expect(run).toThrow(/author: contains a NUL character/)
    expect(run).toThrow(/body: contains a NUL character/)
  })

  it.each([
    ['---js', '---js'],
    ['---javascript', '---javascript'],
    ['---JS', '---JS'],
    ['--- js (spaces)', '--- js '],
    ['---js with CRLF', '---js\r'],
  ])('refuses frontmatter that is not YAML (%s) without running it', (_name, fence) => {
    const marker = '__tioFrontmatterRan'
    expect(() => parseDoc(`${fence}\n{ title: (globalThis.${marker} = true, "t") }\n---\n\nBody.\n`))
      .toThrow(/must open with a bare --- line \(frontmatter is YAML only\).*at line 1/)
    expect(marker in globalThis).toBe(false)
  })

  it('accepts a file with CRLF line endings', () => {
    expect(parseDoc(mdxDoc({ body: 'Line one.\n\nLine two.\n' }).replaceAll('\n', '\r\n'))).toMatchObject({
      title: 'A Test Post',
      content: '\r\nLine one.\r\n\r\nLine two.\r\n',
    })
  })

  it('rejects an unknown key instead of silently dropping it', () => {
    expect(() => parseDoc(mdxDoc().replace('isPublished', 'updateAt: 2024-07-01\nisPublished')))
      .toThrow(/frontmatter: Unrecognized key: "updateAt"/)
  })

  it('rejects a missing title', () => {
    expect(() => parseDoc(mdxDoc({ title: undefined })))
      .toThrow(/title: expected a non-empty string/)
  })

  it('rejects a non-boolean isPublished', () => {
    expect(() => parseDoc(mdxDoc({ isPublished: 'yes' })))
      .toThrow(/isPublished: expected a boolean/)
  })

  it('aggregates every invalid field into one error', () => {
    const run = () => parseDoc(mdxDoc({
      title: undefined,
      author: undefined,
      createdAt: 'not-a-date',
      isPublished: undefined,
    }))
    expect(run).toThrow(/title/)
    expect(run).toThrow(/author/)
    expect(run).toThrow(/createdAt/)
    expect(run).toThrow(/isPublished/)
  })

  it('rejects an MDX body the frontend cannot compile, naming the file line', () => {
    // mdxDoc's frontmatter takes lines 1-8, so the body starts at line 9
    expect(() => parseDoc(mdxDoc({ body: 'Fine.\n\nAn <b>unclosed tag.\n' })))
      .toThrow(/body: MDX syntax error at line 11: Expected a closing tag for `<b>` before the end of `paragraph`/)
  })

  it.each([
    ['an import', 'import x from \'y\'\n\nText.\n', 'mdxjsEsm'],
    ['an inline expression', 'Two is {1 + 1}.\n', 'mdxTextExpression'],
    ['a flow expression', '{1 + 1}\n', 'mdxFlowExpression'],
    ['an expression prop', '<MdxImage src="a" width={480} />\n', 'an expression or spread prop'],
    ['a spread prop', '<MdxImage {...props} />\n', 'an expression or spread prop'],
  ])('rejects JavaScript in the body: %s', (_name, body, kind) => {
    expect(() => parseDoc(mdxDoc({ body })))
      .toThrow(`body: JavaScript is not allowed in posts at line 9 (${kind})`)
  })

  it('parses GFM as the frontend does: a footnote definition is checked too', () => {
    expect(() => parseDoc(mdxDoc({ body: 'Text[^1].\n\n[^1]: <MdxImage src="a" width={480} />\n' })))
      .toThrow('body: JavaScript is not allowed in posts at line 11 (an expression or spread prop)')
  })

  it('parses GFM as the frontend does: a | in an attribute inside a table cell is a syntax error', () => {
    expect(() => parseDoc(mdxDoc({ body: '| a | b |\n| - | - |\n| <Link href="/a|b">x</Link> | y |\n' })))
      .toThrow(/body: MDX syntax error at line 11: Unexpected end of file in attribute value/)
  })

  it.each([
    ['a fragment', 'Text <>inside</> it.\n', 'body: fragments (<>) are not allowed in posts at line 9'],
    ['a member name', '<A.B />\n', 'body: <A.B> at line 9: member names are not allowed in posts'],
    ['an attribute without a value', '<MdxImage src="a" alt="b" width="1" height="2" priority />\n', 'body: <MdxImage> at line 9: attribute "priority" has no value'],
  ])('rejects JSX the frontend cannot take: %s', (_name, body, message) => {
    expect(() => parseDoc(mdxDoc({ body }))).toThrow(message)
  })

  it('accepts components with string props', () => {
    expect(parseDoc(mdxDoc({ body: '<MdxImage src="a/b" width="480" height="320" alt="An image" />\n' })).content).toContain('<MdxImage')
  })

  it('throws on structurally invalid paths', () => {
    root = makeContentDir({
      'floating.mdx': mdxDoc(),
    })
    expect(() => parseMdxFile(path.join(root, 'floating.mdx'), root))
      .toThrow(/Invalid content path/)
  })

  it('names the problem when the frontmatter is YAML but not a mapping', () => {
    expect(() => parseDoc('---\njust a sentence\n---\n\nBody.\n'))
      .toThrow(/Invalid frontmatter YAML in ".*a\.mdx": frontmatter must be a YAML mapping of keys to values/)
  })

  it('names the file when the YAML itself is malformed', () => {
    root = makeContentDir({ 'articles/broken.mdx': '---\ntitle: [unclosed\n---\nBody\n' })
    expect(() => parseMdxFile(path.join(root, 'articles/broken.mdx'), root))
      .toThrow(/Invalid frontmatter YAML in ".*broken\.mdx"/)
  })

  it('rejects an over-long author (varchar limit)', () => {
    expect(() => parseDoc(mdxDoc({
      author: 'a'.repeat(120),
    })))
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
