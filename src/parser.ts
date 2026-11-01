import type { Root } from 'mdast'
import type { ContentRecord, StructureResult } from './types.ts'
import fs from 'node:fs'
import path from 'node:path'
import { createProcessor } from '@mdx-js/mdx'
import slugify from '@sindresorhus/slugify'
import matter from 'gray-matter'
import yaml from 'js-yaml'
import { z } from 'zod'
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

/** A 'yyyy-MM-dd' calendar date, anchored to CONTENT_TIME_ZONE midnight (ADR-0003). */
function calendarDate(value: unknown, ctx: z.RefinementCtx): Date {
  try {
    return parseFrontmatterDate(value)
  }
  catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message })
    return z.NEVER
  }
}

// XML 1.0 forbids the C0 controls other than tab, LF and CR: one pasted
// into a title or description would make the whole RSS feed unreadable.
function hasControlCharacter(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D
  })
}

const NON_EMPTY = 'expected a non-empty string'
const NO_CONTROL_CHARACTERS = 'contains a control character (invalid in the RSS feed)'

/**
 * The authoring contract for frontmatter. Strict: an unknown key (say a
 * typo'd `updateAt`) fails the parse instead of being silently dropped.
 */
const frontmatterSchema = z.strictObject({
  title: z.string(NON_EMPTY).refine(text => text.trim() !== '', NON_EMPTY).refine(text => !hasControlCharacter(text), NO_CONTROL_CHARACTERS),
  description: z.string('expected a string when present').refine(text => !hasControlCharacter(text), NO_CONTROL_CHARACTERS).optional(),
  author: z.string(NON_EMPTY).refine(text => text.trim() !== '', NON_EMPTY).max(100, 'exceeds 100 characters (varchar limit)'),
  // optional() lets an absent key reach the date parser, which names the problem
  createdAt: z.unknown().optional().transform(calendarDate),
  updatedAt: z.unknown().optional().transform((value, ctx) => value == null
    ? null
    : calendarDate(value, ctx)),
  isPublished: z.boolean('expected a boolean'),
}).refine(
  ({ createdAt, updatedAt }) => updatedAt === null || updatedAt >= createdAt,
  {
    path: ['updatedAt'],
    message: 'must not be before createdAt',
  },
)

// The frontend compiles post bodies with @mdx-js/mdx and refuses to run any
// JavaScript in them (tianwei.io src/lib/mdx.tsx). Checking the same here
// keeps a body it cannot render out of the database: otherwise the sync
// succeeds and that post's page fails in production.
const mdxParser = createProcessor()
const JAVASCRIPT_NODES = new Set(['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression'])

interface MdxNode {
  type: string
  children?: MdxNode[]
  attributes?: { type: string, value?: unknown }[]
  position?: { start: { line: number } }
}

/**
 * Why the frontend could not render this MDX body, if it could not: a
 * syntax error, or JavaScript (import/export, `{expression}`, `prop={value}`,
 * `{...spread}`). Line numbers count from the top of the file.
 */
function mdxBodyErrors(body: string, linesBeforeBody: number): string[] {
  let tree: Root
  try {
    tree = mdxParser.parse(body)
  }
  catch (err) {
    // a VFileMessage: `line` is relative to the body, `reason` carries body positions too
    const { line, reason } = err as { line?: number, reason?: string }
    const where = line === undefined
      ? ''
      : ` at line ${linesBeforeBody + line}`
    return [`body: MDX syntax error${where}: ${(reason ?? String(err)).replace(/ \(\d+:\d+(?:-\d+:\d+)?\)/, '')}`]
  }

  const errors: string[] = []
  const visit = (node: MdxNode): void => {
    const jsAttribute = node.attributes?.some(attribute => attribute.type === 'mdxJsxExpressionAttribute'
      || (typeof attribute.value === 'object' && attribute.value !== null)) === true
    if (JAVASCRIPT_NODES.has(node.type) || jsAttribute) {
      const line = node.position === undefined
        ? ''
        : ` at line ${linesBeforeBody + node.position.start.line}`
      errors.push(`body: JavaScript is not allowed in posts${line} (${jsAttribute ? 'an expression or spread prop' : node.type}); give components string props`)
    }
    node.children?.forEach(visit)
  }
  visit(tree as MdxNode)
  return errors
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

  let data: unknown
  let content: string
  try {
    ({ data, content } = matter(raw, FRONTMATTER_OPTIONS))
  }
  catch (err) {
    // js-yaml errors carry a line number but no file — add the path
    throw new Error(`[parser] Invalid frontmatter YAML in "${filePath}": ${(err as Error).message}`)
  }

  const frontmatter = frontmatterSchema.safeParse(data)
  // gray-matter's content is the file after the closing '---'
  const linesBeforeBody = raw.slice(0, raw.length - content.length).split('\n').length - 1
  const errors = [
    ...(frontmatter.success
      ? []
      : frontmatter.error.issues.map(issue => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`)),
    ...mdxBodyErrors(content, linesBeforeBody),
  ]
  if (!frontmatter.success || errors.length > 0)
    throw new Error(`[parser] Invalid post "${filePath}":\n  - ${errors.join('\n  - ')}`)

  return {
    slug: structure.slug,
    category: structure.category,
    ...frontmatter.data,
    description: frontmatter.data.description ?? null,
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
