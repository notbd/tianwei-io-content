import type { Root } from 'mdast'
import type { ContentRecord } from './types.ts'
import fs from 'node:fs'
import path from 'node:path'
import { createProcessor } from '@mdx-js/mdx'
import slugify from '@sindresorhus/slugify'
import yaml from 'js-yaml'
import remarkGfm from 'remark-gfm'
import { z } from 'zod'
import { AUTHOR_MAX_LENGTH, CATEGORY_MAX_LENGTH, SLUG_MAX_LENGTH } from '../drizzle/schema.ts'
import { CONTENT_ROOT } from './config.ts'
import { parseFrontmatterDate } from './date.ts'
import { messageOf } from './errors.ts'

/**
 * The category and slug of the post at `filePath`, which must be
 *   {contentRoot}/{category}/{post_name}.mdx
 * Reads the path only, never the disk. Throws, naming what is wrong.
 */
export function postLocation(filePath: string, contentRoot: string): { category: string, slug: string } {
  const invalid = (reason: string) => new Error(`[parser] Invalid content path "${filePath}": ${reason}`)
  const relativePath = path.relative(contentRoot, filePath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath))
    throw invalid(`path is outside the content root: "${filePath}"`)

  const pathSegments = relativePath.split(path.sep)
  if (pathSegments.length !== 2)
    throw invalid(`expected structure {content}/{category}/{post}.mdx, got "${relativePath}"`)

  const [rawCategory = '', rawFilename = ''] = pathSegments
  if (rawCategory === '' || rawFilename === '')
    throw invalid(`malformed content path: "${relativePath}"`)

  if (!rawFilename.toLowerCase().endsWith('.mdx'))
    throw invalid(`invalid file type "${rawFilename}": expected an .mdx file`)

  // slugify can yield '' (e.g. symbol-only or non-Latin names), and the DB
  // columns are varchars; catch both here, in the parse phase, so a bad
  // name can never abort the sync transaction midway.
  const category = slugify(rawCategory)
  const slug = slugify(path.basename(rawFilename, path.extname(rawFilename)))

  if (category.length === 0)
    throw invalid(`category "${rawCategory}" slugifies to an empty string`)
  if (category.length > CATEGORY_MAX_LENGTH)
    throw invalid(`category "${rawCategory}" slugifies to ${category.length} chars (max ${CATEGORY_MAX_LENGTH})`)
  if (slug.length === 0)
    throw invalid(`filename "${rawFilename}" slugifies to an empty slug`)
  if (slug.length > SLUG_MAX_LENGTH)
    throw invalid(`filename "${rawFilename}" slugifies to a ${slug.length}-char slug (max ${SLUG_MAX_LENGTH})`)

  return { category, slug }
}

/** A bare `---` line: frontmatter is YAML, with no language after the fence. */
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/
/** The next line that starts with `---` ends the frontmatter. */
const FRONTMATTER_CLOSE = '\n---'

/**
 * Frontmatter as the mapping the author wrote. CORE_SCHEMA has no
 * timestamp type: the default schema turns an unquoted `2024-02-30` into a
 * Date that has already rolled over to March 1, before any validation can
 * see what the author wrote. It has no JS types either, so load() is safe.
 * Dates stay the authored strings for parseFrontmatterDate to check.
 */
function loadFrontmatter(yamlText: string): object {
  // js-yaml 3 types load() as any; a scalar is no frontmatter (a list
  // passes here and fails the schema)
  const data: unknown = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA })
  if (typeof data !== 'object' || data === null)
    throw new Error('frontmatter must be a YAML mapping of keys to values')
  return data
}

/** A 'yyyy-MM-dd' calendar date, anchored to CONTENT_TIME_ZONE midnight (ADR-0003). */
function calendarDate(value: unknown, ctx: z.RefinementCtx): Date {
  try {
    return parseFrontmatterDate(value)
  }
  catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: messageOf(err),
    })
    return z.NEVER
  }
}

// One code point outside XML 1.0's Char range (a pasted control character,
// U+FFFE, a lone surrogate) in a title or description makes the whole RSS
// feed unreadable. The `u` flag matches by code point, so emoji pass.
const NON_XML_CHARACTER = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u

function isXmlText(text: string): boolean {
  return !NON_XML_CHARACTER.test(text)
}

// Postgres text and varchar cannot store NUL: one would fail the whole sync
// transaction at write time instead of naming the field here.
function hasNul(text: string): boolean {
  return text.includes('\0')
}

const NON_EMPTY = 'expected a non-empty string'
const XML_TEXT_ONLY = 'contains a character XML 1.0 forbids (it would break the RSS feed)'
const NO_NUL = 'contains a NUL character (the database cannot store it)'

const nonEmptySchema = z.string(NON_EMPTY).refine(text => text.trim() !== '', NON_EMPTY)

/**
 * The authoring contract for frontmatter. Strict: an unknown key (say a
 * typo'd `updateAt`) fails the parse instead of being silently dropped.
 */
const frontmatterSchema = z.strictObject({
  title: nonEmptySchema.refine(isXmlText, XML_TEXT_ONLY),
  description: z.string('expected a string when present').refine(isXmlText, XML_TEXT_ONLY).optional(),
  author: nonEmptySchema.refine(text => !hasNul(text), NO_NUL).max(AUTHOR_MAX_LENGTH, `exceeds ${AUTHOR_MAX_LENGTH} characters (varchar limit)`),
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

// The frontend compiles post bodies with @mdx-js/mdx and the same rules
// (tianwei.io src/lib/mdx.tsx). Checking them here keeps a body it cannot
// render out of the database: otherwise the sync succeeds and that post's
// page fails in production. The sync's own parse stops a syntax error,
// JavaScript and what else needs no contract (steps 1 and 3 of
// elementErrors below); which components and attributes a body may use
// needs the frontend's contract, which `pnpm check:contract` brings. Both
// sides must parse the same syntax: when the frontend adds a remark plugin
// that extends it, add the plugin here too.
const mdxParser = createProcessor({
  remarkPlugins: [remarkGfm],
})
const JAVASCRIPT_NODES = new Set(['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression'])
const JSX_ELEMENTS = new Set(['mdxJsxFlowElement', 'mdxJsxTextElement'])

/**
 * The components /contract.json lets a post use (src/contract.ts reads
 * it): each one's attribute validator and whether it takes content
 * between its tags.
 */
export type ComponentRules = ReadonlyMap<string, { attributes: z.ZodType, children: boolean }>

type MdxNode = {
  type: string
  /** a JSX element's name; null for a fragment */
  name?: string | null | undefined
  children?: MdxNode[] | undefined
  attributes?: { type: string, name?: string | undefined, value?: unknown }[] | undefined
  position?: { start: { line: number } } | undefined
}

/**
 * What is wrong with one JSX element the author wrote, checked in the order
 * the frontend checks them and stopping at the first step that fails:
 * 1. no JavaScript (`prop={value}`, `{...spread}`), no fragment, no member
 *    name (`<A.B>`);
 * 2. a component the contract lists;
 * 3. every attribute has a value (`<MdxImage priority />` has none);
 * 4. no attribute twice, and all of them, as written, pass the component's
 *    schema (so `children="x"` and `key="x"` fail like any unknown one);
 * 5. no content between the tags of a component that takes none.
 * Without `components` (the sync's own parse) only steps 1 and 3 run.
 */
function elementErrors(node: MdxNode, where: string, components: ComponentRules | undefined): string[] {
  const jsAttribute = node.attributes?.some(attribute => attribute.type === 'mdxJsxExpressionAttribute'
    || (typeof attribute.value === 'object' && attribute.value !== null)) === true
  if (jsAttribute)
    return [`body: JavaScript is not allowed in posts${where} (an expression or spread prop); give components string props`]
  if (node.name == null)
    return [`body: fragments (<>) are not allowed in posts${where}`]
  if (node.name.includes('.'))
    return [`body: <${node.name}>${where}: member names are not allowed in posts`]

  const component = components?.get(node.name)
  if (components !== undefined && component === undefined) {
    const listed = Array.from(components.keys(), name => `<${name}>`).join(', ')
    return [`body: <${node.name}>${where} is not a post component (the frontend's contract lists ${listed})`]
  }

  const attributes = node.attributes ?? []
  const valueless = attributes.filter(attribute => attribute.value == null)
  if (valueless.length > 0)
    return valueless.map(attribute => `body: <${node.name}>${where}: attribute "${attribute.name}" has no value; give it a string`)

  if (component === undefined)
    return []

  const names = attributes.map(attribute => attribute.name)
  const repeated = names.filter((name, i) => names.indexOf(name) !== i)
  if (repeated.length > 0)
    return [`body: <${node.name}>${where}: attribute "${repeated[0]}" is given more than once`]
  const parsed = component.attributes.safeParse(Object.fromEntries(attributes.map(attribute => [attribute.name, attribute.value])))
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => {
      const field = issue.path.length > 0
        ? `${issue.path.join('.')}: `
        : ''
      return `body: <${node.name}>${where}: ${field}${issue.message}`
    })
  }

  if (!component.children && (node.children?.length ?? 0) > 0)
    return [`body: <${node.name}>${where} takes no content between its tags`]

  return []
}

/**
 * Why the frontend could not render this MDX body, if it could not: a
 * syntax error (MDX with GFM, as the frontend parses it), JavaScript
 * (import/export, `{expression}`, `prop={value}`, `{...spread}`), or a JSX
 * element the rules above refuse. Line numbers count from the top of the
 * file. Each rule lives only here: the sync runs it without a contract,
 * `pnpm check:contract` with one.
 */
function mdxBodyErrors(body: string, linesBeforeBody: number, components?: ComponentRules): string[] {
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
    const where = node.position === undefined
      ? ''
      : ` at line ${linesBeforeBody + node.position.start.line}`
    if (JAVASCRIPT_NODES.has(node.type))
      errors.push(`body: JavaScript is not allowed in posts${where} (${node.type}); give components string props`)
    else if (JSX_ELEMENTS.has(node.type))
      errors.push(...elementErrors(node, where, components))
    node.children?.forEach(visit)
  }
  visit(tree)
  return errors
}

/**
 * Parse a single MDX file into a ContentRecord.
 * Throws with an aggregated message listing every invalid frontmatter field.
 * With `components`, the body is held to the frontend's contract as well.
 */
export function parseMdxFile(
  filePath: string,
  contentRoot: string = CONTENT_ROOT,
  components?: ComponentRules,
): ContentRecord {
  const { category, slug } = postLocation(filePath, contentRoot)

  const raw = fs.readFileSync(filePath, 'utf-8')

  // readFileSync('utf-8') replaces invalid bytes with U+FFFD instead of
  // erroring: a wrongly-encoded file would otherwise sync mojibake.
  if (raw.includes('�'))
    throw new Error(`[parser] "${filePath}" contains invalid UTF-8 (found U+FFFD replacement characters)`)

  if (!FRONTMATTER_OPEN.test(raw)) {
    const firstLine = raw.split(/\r?\n/, 1)[0] ?? ''
    throw new Error(`[parser] "${filePath}" must open with a bare --- line (frontmatter is YAML only), found ${JSON.stringify(firstLine)} at line 1`)
  }

  // from right after the opening fence, so js-yaml counts lines as the file does
  const yamlStart = '---'.length
  const close = raw.indexOf(FRONTMATTER_CLOSE, yamlStart)
  if (close === -1)
    throw new Error(`[parser] "${filePath}" has no closing --- line after its frontmatter`)
  // the body is what follows the closing fence, less the line break that ends it
  const content = raw.slice(close + FRONTMATTER_CLOSE.length).replace(/^\r?\n?/, '')

  let data: object
  try {
    data = loadFrontmatter(raw.slice(yamlStart, close))
  }
  catch (err) {
    // js-yaml errors carry a line number but no file; add the path
    throw new Error(`[parser] Invalid frontmatter YAML in "${filePath}": ${messageOf(err)}`)
  }

  const frontmatter = frontmatterSchema.safeParse(data)
  const linesBeforeBody = raw.slice(0, raw.length - content.length).split('\n').length - 1
  const errors = [
    ...(frontmatter.success
      ? []
      : frontmatter.error.issues.map(issue => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`)),
    ...(hasNul(content)
      ? [`body: ${NO_NUL}`]
      : []),
    ...mdxBodyErrors(content, linesBeforeBody, components),
  ]
  if (!frontmatter.success || errors.length > 0)
    throw new Error(`[parser] Invalid post "${filePath}":\n  - ${errors.join('\n  - ')}`)

  return {
    slug,
    category,
    ...frontmatter.data,
    description: frontmatter.data.description ?? null,
    content,
  }
}

/**
 * Parse every .mdx file under the content root into ContentRecord[].
 *
 * Fail-fast contract: if ANY file is invalid, this throws a single
 * aggregated error listing every failure; callers must not touch the
 * database with a partial parse.
 *
 * Also rejects duplicate slugs across categories: slug is the primary
 * identity of a post in the database, so two files mapping to the same
 * slug would silently overwrite each other.
 *
 * With `components`, every body (drafts too) is held to the frontend's
 * contract as well.
 */
export function parseAllPosts(contentRoot: string = CONTENT_ROOT, components?: ComponentRules): ContentRecord[] {
  if (!fs.existsSync(contentRoot))
    return []

  const categories = fs
    .readdirSync(contentRoot)
    // statSync follows a symlinked category directory
    .filter(name => fs.statSync(path.join(contentRoot, name)).isDirectory())

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
        records.push(parseMdxFile(mdxFilePath, contentRoot, components))
      }
      catch (err) {
        failures.push(messageOf(err))
      }
    }
  }

  if (failures.length > 0)
    throw new Error(`[parser] ${failures.length} file(s) failed to parse:\n${failures.join('\n')}`)

  assertUniqueSlugs(records)

  return records
}

/** Throw if two records share a slug (e.g. same filename in two categories). */
function assertUniqueSlugs(records: ContentRecord[]): void {
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
