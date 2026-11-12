import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { postLocation } from '../../src/parser.ts'

// postLocation reads the path only: nothing here is on the disk
const root = path.resolve('content-root')

describe('postLocation', () => {
  it('accepts {root}/{category}/{post}.mdx and derives category + slug', () => {
    expect(postLocation(path.join(root, 'articles/my-post.mdx'), root)).toEqual({ category: 'articles', slug: 'my-post' })
  })

  it('slugifies human-readable file and folder names', () => {
    expect(postLocation(path.join(root, 'My Notes/Hello World.mdx'), root)).toEqual({ category: 'my-notes', slug: 'hello-world' })
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
    const filePath = path.join(root, file)
    expect(() => postLocation(filePath, root)).toThrow(`[parser] Invalid content path "${filePath}": ${reason}`)
  })

  it('rejects paths outside the content root', () => {
    const outside = path.join(root, '..', 'articles', 'escape.mdx')
    expect(() => postLocation(outside, root)).toThrow(`path is outside the content root: "${outside}"`)
  })
})
