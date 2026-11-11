import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateMdxFileStructure } from '../../src/parser.ts'
import { makeContentDir, mdxDoc } from '../helpers/fixture-content.ts'

let root = ''

afterEach(() => {
  if (root !== '')
    fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('validateMdxFileStructure', () => {
  it('accepts {root}/{category}/{post}.mdx and derives category + slug', () => {
    root = makeContentDir({
      'articles/my-post.mdx': mdxDoc(),
    })
    const result = validateMdxFileStructure(path.join(root, 'articles/my-post.mdx'), root)
    expect(result).toEqual({ ok: true, category: 'articles', slug: 'my-post' })
  })

  it('slugifies human-readable file and folder names', () => {
    root = makeContentDir({
      'My Notes/Hello World.mdx': mdxDoc(),
    })
    const result = validateMdxFileStructure(path.join(root, 'My Notes/Hello World.mdx'), root)
    expect(result).toEqual({ ok: true, category: 'my-notes', slug: 'hello-world' })
  })

  it('rejects nested paths deeper than {category}/{post}', () => {
    root = makeContentDir({
      'articles/drafts/deep.mdx': mdxDoc(),
    })
    const result = validateMdxFileStructure(path.join(root, 'articles/drafts/deep.mdx'), root)
    expect(result).toEqual({
      ok: false,
      reason: 'expected structure {content}/{category}/{post}.mdx, got "articles/drafts/deep.mdx"',
    })
  })

  it('rejects files at the content root', () => {
    root = makeContentDir({
      'floating.mdx': mdxDoc(),
    })
    const result = validateMdxFileStructure(path.join(root, 'floating.mdx'), root)
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects paths outside the content root', () => {
    root = makeContentDir({
      'articles/ok.mdx': mdxDoc(),
    })
    const outside = path.join(root, '..', 'articles', 'escape.mdx')
    const result = validateMdxFileStructure(outside, root)
    expect(result).toEqual({
      ok: false,
      reason: `path is outside the content root: "${outside}"`,
    })
  })

  it('rejects non-mdx extensions', () => {
    root = makeContentDir({
      'articles/readme.md': mdxDoc(),
    })
    const result = validateMdxFileStructure(path.join(root, 'articles/readme.md'), root)
    expect(result).toEqual({
      ok: false,
      reason: 'invalid file type "readme.md": expected an .mdx file',
    })
  })

  it('rejects a category that is a file, not a directory', () => {
    root = makeContentDir({ articles: 'i am a file' })
    const result = validateMdxFileStructure(path.join(root, 'articles/post.mdx'), root)
    expect(result).toEqual({
      ok: false,
      reason: 'category "articles" is not a directory under the content root',
    })
  })

  it('rejects a filename that slugifies to an empty slug', () => {
    root = makeContentDir({
      'articles/---.mdx': mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, 'articles/---.mdx'), root))
      .toEqual({
        ok: false,
        reason: 'filename "---.mdx" slugifies to an empty slug',
      })
  })

  it('rejects a category that slugifies to an empty string', () => {
    root = makeContentDir({
      '日本語/post.mdx': mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, '日本語/post.mdx'), root))
      .toEqual({
        ok: false,
        reason: 'category "日本語" slugifies to an empty string',
      })
  })

  it('rejects a slug longer than the slug column', () => {
    const longName = 'a'.repeat(250)
    root = makeContentDir({
      [`articles/${longName}.mdx`]: mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, `articles/${longName}.mdx`), root))
      .toEqual({
        ok: false,
        reason: `filename "${longName}.mdx" slugifies to a 250-char slug (max 200)`,
      })
  })

  it('rejects a category longer than the category column', () => {
    const longCategory = 'c'.repeat(150)
    root = makeContentDir({
      [`${longCategory}/post.mdx`]: mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, `${longCategory}/post.mdx`), root))
      .toEqual({
        ok: false,
        reason: `category "${longCategory}" slugifies to 150 chars (max 100)`,
      })
  })
})
