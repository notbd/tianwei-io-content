import type { ContentRecord } from './types.ts'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import slugify from '@sindresorhus/slugify'
import { isValid, parse as parseDate } from 'date-fns'
import matter from 'gray-matter'

export const CONTENT_ROOT = path.resolve(process.cwd(), 'content')

/**
 * Parse a single MDX file into a ContentRecord object.
 * The file must live at CONTENT_ROOT/{category}/{post_name}.mdx
 */
export function parseMdxFile(filePath: string): ContentRecord | null {
  const structure = validateMdxFileStructure(filePath)
  if (!structure)
    return null

  const { category, slug } = structure

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const { data, content } = matter(raw)

    // Validate required frontmatter fields
    const invalidFields: string[] = []
    const errMsgs: string[] = []

    if (!data.title || typeof data.title !== 'string') {
      invalidFields.push('title')
    }

    if (!data.author || typeof data.author !== 'string') {
      invalidFields.push('author')
    }

    try {
      throwableParseDate(data.createdAt)
    }
    catch (err) {
      invalidFields.push('createdAt')
      errMsgs.push((err as Error).message)
    }

    if (data.isPublished === undefined || data.isPublished === null || typeof data.isPublished !== 'boolean') {
      invalidFields.push('isPublished')
    }

    if (invalidFields.length) {
      errMsgs.push(`[parser/invalid_attr] Invalid or missing frontmatter attributes: [${invalidFields.join(', ')}]`)
      throw new Error(errMsgs.join('\n'))
    }

    return {
      category,
      slug,
      title: data.title,
      description: data.description,
      author: data.author,
      createdAt: throwableParseDate(data.createdAt),
      isPublished: data.isPublished,
      content,
    }
  }
  catch (err) {
    throw new Error(`[parser] Failed to parse MDX at ${filePath}: \n${(err as Error).message}`)
  }
}

function throwableParseDate(value: unknown): Date {
  if (value === undefined || value === null) {
    throw new Error(
      `[parser/date] - Undefined value`,
    )
  }

  if (value instanceof Date && isValid(value))
    return value

  if (typeof value === 'string' && value.trim()) {
    const parsed = parseDate(value.trim(), 'yyyy-MM-dd', new Date())
    if (isValid(parsed))
      return parsed
    throw new Error(`[parser/date] - Invalid date format for '${value}': expected 'yyyy-MM-dd'`)
  }

  throw new Error(
    `[parser/date] - Unsupported data type: expected string or Date`,
  )
}

/**
 * Validate that the given file path follows the required structure:
 *   CONTENT_ROOT/{category}/{post_name}.mdx
 *
 * Returns the category name and filename if valid, otherwise null.
 */
export function validateMdxFileStructure(
  filePath: string,
): { category: string, slug: string } | null {
  const relativePath = path.relative(CONTENT_ROOT, filePath)
  const pathSegments = relativePath.split(path.sep)

  // Must have exactly two segments: category + file
  if (pathSegments.length !== 2) {
    console.error(
      `[parser] Invalid content path: "${filePath}". Expected structure -> content/{category}/{post}.mdx`,
    )
    return null
  }

  const [rawCategory, rawFilename] = pathSegments
  if (!rawCategory || !rawFilename) {
    console.error(`[parser] Malformed content path: "${filePath}".`)
    return null
  }

  const categoryDir = path.join(CONTENT_ROOT, rawCategory)

  // Validate that category exists and is directory
  try {
    const stat = fs.statSync(categoryDir)
    if (!stat.isDirectory()) {
      console.error(
        `[parser] Category "${rawCategory}" in "${filePath}" is not a directory under /content.`,
      )
      return null
    }
  }
  catch {
    console.error(
      `[parser] Missing category folder "${rawCategory}" in "${filePath}". Expected directory under /content.`,
    )
    return null
  }

  // Validate MDX extension
  if (!rawFilename.toLowerCase().endsWith('.mdx')) {
    console.error(
      `[parser] Invalid file type "${rawFilename}" in "${filePath}". Expected an .mdx file.`,
    )
    return null
  }

  return {
    category: slugify(rawCategory),
    slug: slugify(path.basename(rawFilename, '.mdx')),
  }
}

/**
 * Parse all .mdx files in /content recursively into ContentRecord[].
 */
export function parseAllPosts(): ContentRecord[] {
  if (!fs.existsSync(CONTENT_ROOT))
    return []

  const categories = fs
    .readdirSync(CONTENT_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  const records: ContentRecord[] = []
  for (const category of categories) {
    const categoryDir = path.join(CONTENT_ROOT, category)
    const mdxFilePaths = fs
      .readdirSync(categoryDir)
      .filter(f => f.endsWith('.mdx'))
      .map(f => path.join(categoryDir, f))

    for (const mdxFilePath of mdxFilePaths) {
      const record = parseMdxFile(mdxFilePath)
      if (record)
        records.push(record)
    }
  }

  return records
}
