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

  const longName = 'a'.repeat(250)
  const longCategory = 'c'.repeat(150)

  it.each([
    ['a path deeper than {category}/{post}', 'articles/drafts/deep.mdx', 'expected structure {content}/{category}/{post}.mdx, got "articles/drafts/deep.mdx"'],
    ['a file at the content root', 'floating.mdx', 'expected structure {content}/{category}/{post}.mdx, got "floating.mdx"'],
    ['a non-mdx extension', 'articles/readme.md', 'invalid file type "readme.md": expected an .mdx file'],
    ['a filename that slugifies to an empty slug', 'articles/---.mdx', 'filename "---.mdx" slugifies to an empty slug'],
    ['a category that slugifies to an empty string', '日本語/post.mdx', 'category "日本語" slugifies to an empty string'],
    ['a slug longer than the slug column', `articles/${longName}.mdx`, `filename "${longName}.mdx" slugifies to a 250-char slug (max 200)`],
    ['a category longer than the category column', `${longCategory}/post.mdx`, `category "${longCategory}" slugifies to 150 chars (max 100)`],
  ])('rejects %s', (_name, file, reason) => {
    root = makeContentDir({
      [file]: mdxDoc(),
    })
    expect(validateMdxFileStructure(path.join(root, file), root)).toEqual({ ok: false, reason })
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

  it('rejects a category that is a file, not a directory', () => {
    root = makeContentDir({ articles: 'i am a file' })
    const result = validateMdxFileStructure(path.join(root, 'articles/post.mdx'), root)
    expect(result).toEqual({
      ok: false,
      reason: 'category "articles" is not a directory under the content root',
    })
  })
})
