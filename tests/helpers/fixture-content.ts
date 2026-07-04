import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Create a throwaway content directory from a map of
 * 'category/file.mdx' -> raw file contents.
 * Returns the directory path; caller cleans up via rmSync in afterEach.
 */
export function makeContentDir(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tio-content-'))
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents, 'utf-8')
  }
  return root
}

export interface FrontmatterOverrides {
  title?: string | undefined
  description?: string | undefined
  createdAt?: string | undefined
  updatedAt?: string | undefined
  author?: string | undefined
  isPublished?: boolean | string | undefined
  body?: string
}

/** Build a valid MDX document, with selective overrides/omissions. */
export function mdxDoc(overrides: FrontmatterOverrides = {}): string {
  const fields: Record<string, unknown> = {
    title: 'A Test Post',
    description: 'A description.',
    createdAt: '2024-06-15',
    author: 'Test Author',
    isPublished: true,
    ...overrides,
  }

  const lines = Object.entries(fields)
    .filter(([key, value]) => key !== 'body' && value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`)

  const body = overrides.body ?? 'Hello **world**.\n'
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}
