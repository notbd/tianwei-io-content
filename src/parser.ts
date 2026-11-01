import type { ContentRecord, StructureResult } from './types.ts'
import fs from 'node:fs'
import path from 'node:path'
import slugify from '@sindresorhus/slugify'
import matter from 'gray-matter'
import yaml from 'js-yaml'
import { CONTENT_ROOT } from './config.ts'
import { parseFrontmatterDate } from './date.ts'

/**
 * Validate that the given file path follows the required structure:
 *   {contentRoot}/{category}/{post_name}.mdx
 *
 * Only touches the filesystem to confirm the category directory exists;
 * never logs. Returns the derived category and slug, or a
 * machine-readable failure reason.
 */
export function validateMdxFileStructure(
  filePath: string,
  contentRoot: string = CONTENT_ROOT,
): StructureResult {
  const relativePath = path.relative(contentRoot, filePath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath))
    return { ok: false, reason: `path is outside the content root: "${filePath}"` }

  const pathSegments = relativePath.split(path.sep)
  if (pathSegments.length !== 2)
    return { ok: false, reason: `expected structure {content}/{category}/{post}.mdx, got "${relativePath}"` }

  const [rawCategory, rawFilename] = pathSegments
  if (!rawCategory || !rawFilename)
    return { ok: false, reason: `malformed content path: "${relativePath}"` }

  let categoryIsDirectory: boolean
  try {
    categoryIsDirectory = fs.statSync(path.join(contentRoot, rawCategory)).isDirectory()
  }
  catch {
    categoryIsDirectory = false
  }
  if (!categoryIsDirectory)
    return { ok: false, reason: `category "${rawCategory}" is not a directory under the content root` }

  if (!rawFilename.toLowerCase().endsWith('.mdx'))
    return { ok: false, reason: `invalid file type "${rawFilename}": expected an .mdx file` }

  // slugify can yield '' (e.g. symbol-only or non-Latin names), and the DB
  // columns are varchar(200)/varchar(100) — catch both here, in the parse
  // phase, so a bad name can never abort the sync transaction midway.
  const category = slugify(rawCategory)
  const slug = slugify(path.basename(rawFilename, path.extname(rawFilename)))

  if (category.length === 0)
    return { ok: false, reason: `category "${rawCategory}" slugifies to an empty string` }
  if (category.length > 100)
    return { ok: false, reason: `category "${rawCategory}" slugifies to ${category.length} chars (max 100)` }
  if (slug.length === 0)
    return { ok: false, reason: `filename "${rawFilename}" slugifies to an empty slug` }
  if (slug.length > 200)
    return { ok: false, reason: `filename "${rawFilename}" slugifies to a ${slug.length}-char slug (max 200)` }

  return { ok: true, category, slug }
}

/**
 * gray-matter's default YAML schema turns an unquoted `2024-02-30` into a
 * Date that has already rolled over to March 1, before any validation can
 * see what the author wrote. CORE_SCHEMA has no timestamp type (and no JS
 * types, so load() is safe), which leaves dates as the authored strings
 * for parseFrontmatterDate to check.
 */
const FRONTMATTER_OPTIONS = {
  engines: {
    yaml: (input: string): object => yaml.load(input, { schema: yaml.CORE_SCHEMA }),
  },
}

/**
 * Parse a single MDX file into a ContentRecord.
 * Throws with an aggregated message listing every invalid frontmatter field.
 */
export function parseMdxFile(
  filePath: string,
  contentRoot: string = CONTENT_ROOT,
): ContentRecord {
  const structure = validateMdxFileStructure(filePath, contentRoot)
  if (!structure.ok)
    throw new Error(`[parser] Invalid content path "${filePath}": ${structure.reason}`)

  const raw = fs.readFileSync(filePath, 'utf-8')

  // readFileSync('utf-8') replaces invalid bytes with U+FFFD instead of
  // erroring — a wrongly-encoded file would otherwise sync mojibake.
  if (raw.includes('�'))
    throw new Error(`[parser] "${filePath}" contains invalid UTF-8 (found U+FFFD replacement characters)`)

  let data: ReturnType<typeof matter>['data']
  let content: string
  try {
    ({ data, content } = matter(raw, FRONTMATTER_OPTIONS))
  }
  catch (err) {
    // js-yaml errors carry a line number but no file — add the path
    throw new Error(`[parser] Invalid frontmatter YAML in "${filePath}": ${(err as Error).message}`)
  }

  const errors: string[] = []

  if (!data.title || typeof data.title !== 'string')
    errors.push(`title: expected a non-empty string`)

  if (data.description !== undefined && typeof data.description !== 'string')
    errors.push(`description: expected a string when present`)

  if (!data.author || typeof data.author !== 'string')
    errors.push(`author: expected a non-empty string`)
  else if (data.author.length > 100)
    errors.push(`author: exceeds 100 characters (varchar limit)`)

  let createdAt: Date | undefined
  try {
    createdAt = parseFrontmatterDate(data.createdAt)
  }
  catch (err) {
    errors.push(`createdAt: ${(err as Error).message}`)
  }

  let updatedAt: Date | undefined
  if (data.updatedAt !== undefined && data.updatedAt !== null) {
    try {
      updatedAt = parseFrontmatterDate(data.updatedAt)
      if (createdAt !== undefined && updatedAt.getTime() < createdAt.getTime())
        errors.push(`updatedAt: must not be before createdAt`)
    }
    catch (err) {
      errors.push(`updatedAt: ${(err as Error).message}`)
    }
  }

  if (typeof data.isPublished !== 'boolean')
    errors.push(`isPublished: expected a boolean`)

  if (errors.length > 0 || createdAt === undefined)
    throw new Error(`[parser] Invalid frontmatter in "${filePath}":\n  - ${errors.join('\n  - ')}`)

  return {
    slug: structure.slug,
    category: structure.category,
    title: data.title,
    ...(data.description !== undefined && { description: data.description }),
    author: data.author,
    createdAt,
    ...(updatedAt !== undefined && { updatedAt }),
    isPublished: data.isPublished,
    content,
  }
}

/**
 * Parse every .mdx file under the content root into ContentRecord[].
 *
 * Fail-fast contract: if ANY file is invalid, this throws a single
 * aggregated error listing every failure — callers must not touch the
 * database with a partial parse.
 *
 * Also rejects duplicate slugs across categories: slug is the primary
 * identity of a post in the database, so two files mapping to the same
 * slug would silently overwrite each other.
 */
export function parseAllPosts(contentRoot: string = CONTENT_ROOT): ContentRecord[] {
  if (!fs.existsSync(contentRoot))
    return []

  const categories = fs
    .readdirSync(contentRoot, { withFileTypes: true })
    // follow symlinked category dirs too — isDirectory() is false for them
    .filter(dirent => dirent.isDirectory()
      || (dirent.isSymbolicLink() && fs.statSync(path.join(contentRoot, dirent.name)).isDirectory()))
    .map(dirent => dirent.name)

  const records: ContentRecord[] = []
  const failures: string[] = []

  for (const category of categories) {
    const categoryDir = path.join(contentRoot, category)
    const mdxFilePaths = fs
      .readdirSync(categoryDir)
      .filter(filename => filename.toLowerCase().endsWith('.mdx'))
      .map(filename => path.join(categoryDir, filename))

    for (const mdxFilePath of mdxFilePaths) {
      try {
        records.push(parseMdxFile(mdxFilePath, contentRoot))
      }
      catch (err) {
        failures.push((err as Error).message)
      }
    }
  }

  if (failures.length > 0)
    throw new Error(`[parser] ${failures.length} file(s) failed to parse:\n${failures.join('\n')}`)

  assertUniqueSlugs(records)

  return records
}

/** Throw if two records share a slug (e.g. same filename in two categories). */
export function assertUniqueSlugs(records: ContentRecord[]): void {
  const seen = new Map<string, string>()
  const duplicates: string[] = []

  for (const record of records) {
    const existingCategory = seen.get(record.slug)
    if (existingCategory !== undefined)
      duplicates.push(`"${record.slug}" (in both "${existingCategory}" and "${record.category}")`)
    else
      seen.set(record.slug, record.category)
  }

  if (duplicates.length > 0)
    throw new Error(`[parser] Duplicate slugs found: ${duplicates.join(', ')}`)
}
