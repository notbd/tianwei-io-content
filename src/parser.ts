import type { ContentRecord, StructureResult } from './types.ts'
import fs from 'node:fs'
import path from 'node:path'
import slugify from '@sindresorhus/slugify'
import matter from 'gray-matter'
import { CONTENT_ROOT, CONTENT_TIME_ZONE } from './config.ts'

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Milliseconds the given zone's wall clock is ahead of UTC at `utcTs`. */
function timeZoneOffsetMs(utcTs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcTs)).map(part => [part.type, part.value]),
  )
  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return wallClockAsUtc - utcTs
}

/**
 * The UTC instant of midnight of the given calendar date in the given
 * zone. Two correction passes converge across DST transitions.
 */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  let ts = Date.UTC(year, month - 1, day)
  for (let i = 0; i < 2; i++)
    ts = Date.UTC(year, month - 1, day) - timeZoneOffsetMs(ts, timeZone)
  return new Date(ts)
}

/**
 * Parse a frontmatter date value into the UTC instant of midnight in
 * CONTENT_TIME_ZONE — i.e. `createdAt: 2025-10-23` means "October 23
 * where the author lives", stored as an unambiguous instant.
 *
 * Accepts:
 * - 'yyyy-MM-dd' strings
 * - Date instances (js-yaml parses unquoted `2024-01-05` as a UTC-midnight
 *   Date; only its calendar date is meaningful, so it is re-anchored to
 *   the content time zone like the string form)
 *
 * Deterministic regardless of machine timezone. Throws on anything else,
 * including calendar-impossible dates such as 2024-02-30.
 */
export function parseFrontmatterDate(value: unknown): Date {
  if (value === undefined || value === null)
    throw new Error(`[parser/date] Missing value: expected 'yyyy-MM-dd'`)

  let year: number, month: number, day: number

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new Error(`[parser/date] Invalid Date instance`)
    year = value.getUTCFullYear()
    month = value.getUTCMonth() + 1
    day = value.getUTCDate()
  }
  else if (typeof value === 'string') {
    const match = DATE_ONLY_RE.exec(value.trim())
    if (!match)
      throw new Error(`[parser/date] Invalid date format for '${value}': expected 'yyyy-MM-dd'`)

    year = Number(match[1])
    month = Number(match[2])
    day = Number(match[3])

    // Round-trip check rejects impossible dates (e.g. 2024-02-30 rolls over to March)
    const probe = new Date(Date.UTC(year, month - 1, day))
    const roundTrips
      = probe.getUTCFullYear() === year
        && probe.getUTCMonth() === month - 1
        && probe.getUTCDate() === day
    if (!roundTrips)
      throw new Error(`[parser/date] Impossible calendar date '${value}'`)
  }
  else {
    throw new TypeError(`[parser/date] Unsupported type '${typeof value}': expected string or Date`)
  }

  return zonedMidnight(year, month, day, CONTENT_TIME_ZONE)
}

/**
 * Validate that the given file path follows the required structure:
 *   {contentRoot}/{category}/{post_name}.mdx
 *
 * Pure check: never logs. Returns the derived category and slug,
 * or a machine-readable failure reason.
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

  return {
    ok: true,
    category: slugify(rawCategory),
    slug: slugify(path.basename(rawFilename, path.extname(rawFilename))),
  }
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
  const { data, content } = matter(raw)

  const errors: string[] = []

  if (!data.title || typeof data.title !== 'string')
    errors.push(`title: expected a non-empty string`)

  if (data.description !== undefined && typeof data.description !== 'string')
    errors.push(`description: expected a string when present`)

  if (!data.author || typeof data.author !== 'string')
    errors.push(`author: expected a non-empty string`)

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
    ...(data.description !== undefined && { description: data.description as string }),
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
    .filter(dirent => dirent.isDirectory())
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
