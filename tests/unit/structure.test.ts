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
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('expected structure'),
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
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('outside the content root'),
    })
  })

  it('rejects non-mdx extensions', () => {
    root = makeContentDir({
      'articles/readme.md': mdxDoc(),
    })
    const result = validateMdxFileStructure(path.join(root, 'articles/readme.md'), root)
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('.mdx'),
    })
  })

  it('rejects a category that is a file, not a directory', () => {
    root = makeContentDir({ articles: 'i am a file' })
    const result = validateMdxFileStructure(path.join(root, 'articles/post.mdx'), root)
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a directory'),
    })
  })

  it('rejects a filename that slugifies to an empty slug', () => {
    root = makeContentDir({
      'articles/---.mdx': mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, 'articles/---.mdx'), root))
      .toMatchObject({
        ok: false,
        reason: expect.stringContaining('empty slug'),
      })
  })

  it('rejects a category that slugifies to an empty string', () => {
    root = makeContentDir({
      '日本語/post.mdx': mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, '日本語/post.mdx'), root))
      .toMatchObject({
        ok: false,
        reason: expect.stringContaining('empty string'),
      })
  })

  it('rejects a slug longer than the slug column', () => {
    const longName = 'a'.repeat(250)
    root = makeContentDir({
      [`articles/${longName}.mdx`]: mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, `articles/${longName}.mdx`), root))
      .toMatchObject({
        ok: false,
        reason: expect.stringContaining('max 200'),
      })
  })

  it('rejects a category longer than the category column', () => {
    const longCategory = 'c'.repeat(150)
    root = makeContentDir({
      [`${longCategory}/post.mdx`]: mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, `${longCategory}/post.mdx`), root))
      .toMatchObject({
        ok: false,
        reason: expect.stringContaining('max 100'),
      })
  })
})
