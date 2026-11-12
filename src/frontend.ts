/**
 * The content deploy's calls to the frontend: expire its content cache, then
 * prove it serves what was synced. Kept out of the script so they can be
 * tested.
 */
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { CONTENT_ROOT } from './config.ts'
import { readEnv } from './env.ts'
import { messageOf } from './errors.ts'
import { parseAllPosts } from './parser.ts'

// a hung frontend must fail the deploy step, not stall it for minutes; the
// timeout covers reading the whole body too
export const REQUEST_TIMEOUT_MS = 60_000
const CHECK_CONCURRENCY = 4
const RECONCILE_ROUNDS = 3
const RECONCILE_ROUND_DELAY_MS = 5_000

/**
 * The production frontend. A public value, so a constant rather than a
 * secret: the deploy cannot be pointed at another environment by mistake.
 */
const PRODUCTION_FRONTEND = 'https://tianwei.io'

/**
 * The frontend `check:contract` and `frontend:revalidate` talk to: the
 * production one, unless FRONTEND_URL points them at a stack on this
 * machine (say http://localhost:3000). The deploy workflow does not set it.
 */
export function frontendFromEnv(): URL {
  return new URL(readEnv('FRONTEND_URL') ?? PRODUCTION_FRONTEND)
}

/**
 * The frontend `pnpm dev` revalidates after every sync: FRONTEND_URL, but
 * only when its host is 127.0.0.1 or localhost. This is the one gate
 * between the local watcher and the production frontend.
 */
export function localFrontendFromEnv(): URL | undefined {
  const value = readEnv('FRONTEND_URL')
  if (value === undefined)
    return undefined
  if (!URL.canParse(value))
    throw new Error(`FRONTEND_URL is not a URL: "${value}"`)
  const url = new URL(value)
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    ? url
    : undefined
}

const revalidatedPostsSchema = z.object({
  revalidated: z.array(z.string()),
})

/**
 * POST /api/revalidate: the frontend reads the content through the API
 * first and expires the `posts` tag only if every read worked. Anything but
 * a 200 whose `revalidated` lists `posts` fails the deploy; a 502 means the
 * read failed and nothing was expired.
 */
export async function revalidateFrontend(frontend: URL, secret: string): Promise<unknown> {
  const endpoint = new URL('/api/revalidate', frontend)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({
      tags: ['posts'],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const rawBody = await response.text()

  if (response.status === 502)
    throw new Error(`[revalidate] The frontend could not read the API, so it expired nothing and still serves the previous content (502): ${rawBody}`)
  if (response.status !== 200)
    throw new Error(`[revalidate] Failed (${response.status}): ${rawBody}`)

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  }
  catch {
    // e.g. a proxy/CDN HTML error page with a 200 status
    throw new Error(`[revalidate] Non-JSON response (${response.status}) from ${endpoint.href}: ${rawBody.slice(0, 300)}`)
  }

  const parsed = revalidatedPostsSchema.safeParse(payload)
  if (!parsed.success || !parsed.data.revalidated.includes('posts'))
    throw new Error(`[revalidate] 200 without "posts" in revalidated: ${rawBody.slice(0, 300)}`)

  return payload
}

/** The meta tag on each /posts/<slug> page: the SHA-256 of the body it rendered. */
export const POST_BODY_HASH_META = 'post-body-sha256'

/** SHA-256 of a post body as UTF-8, untrimmed: what the frontend reports in that tag. */
export function postBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

const META_TAG = /<meta\b[^>]*>/gi
const ATTRIBUTE = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/g

/**
 * The content of every <meta name="post-body-sha256"> on the page, wherever
 * the tag is in the HTML (not only in <head>). A tag without a content
 * attribute counts too, as ''. Reads the tags' attributes, never just any
 * 64-digit hex on the page.
 *
 * It finds the tags in the text and does not parse HTML, so the same text
 * inside a comment or a script counts as a tag. One of those next to the
 * real tag fails the page, which must have exactly one. One of those alone,
 * without a real tag, is compared with the expected hash and fails as well:
 * to pass, the page would have to print the new body's correct hash there.
 */
export function postBodyHashesIn(html: string): string[] {
  const hashes: string[] = []
  for (const [tag] of html.matchAll(META_TAG)) {
    const attributes = new Map(Array.from(tag.matchAll(ATTRIBUTE), ([, name = '', double, single, bare]) => [
      name.toLowerCase(),
      double ?? single ?? bare ?? '',
    ]))
    if (attributes.get('name') === POST_BODY_HASH_META)
      hashes.push(attributes.get('content') ?? '')
  }
  return hashes
}

/** One request of a reconcile round and what its answer must be. */
type Check = {
  path: string
  status: 200 | 404
  /** the body hash a post page must report */
  hash?: string | undefined
}

export type ReconcileOptions = {
  /** Content to compare against; defaults to the repo's content/ */
  contentRoot?: string
  /** Pause before a round is tried again */
  roundDelayMs?: number
  /** Where the per-request lines go (status, x-vercel-cache, age) */
  log?: (line: string) => void
}

/**
 * Prove the frontend serves what was just synced, after the revalidation.
 * The content is parsed once, on entry, and every round compares against
 * that snapshot:
 * - the sitemap's /posts/<slug> pages are exactly the published posts;
 * - every page the sitemap lists answers 200, and each post page has
 *   exactly one post-body-sha256 tag, equal to the hash of the body synced
 *   here (a page that failed to re-render after the expiry keeps serving
 *   its previous version with a 200, which only the hash tells apart);
 * - /feed.xml and every published post's /opengraph-image answer 200;
 * - every draft's /posts/<slug> answers 404.
 * Every body is read to the end within the request's timeout. A round
 * collects every problem, a sitemap that cannot be read included, and ends
 * when its last request has; with any problem it is tried again after a
 * pause, three rounds in all.
 */
export async function reconcile(frontend: URL, options: ReconcileOptions = {}): Promise<number> {
  const records = parseAllPosts(options.contentRoot ?? CONTENT_ROOT)
  const published = new Map(records
    .filter(record => record.isPublished)
    .map(record => [
      record.slug,
      postBodyHash(record.content),
    ]))
  const drafts = records.filter(record => !record.isPublished).map(record => record.slug)
  const roundDelayMs = options.roundDelayMs ?? RECONCILE_ROUND_DELAY_MS
  const log = options.log ?? console.info

  let failures: string[] = []
  for (let round = 1; round <= RECONCILE_ROUNDS; round++) {
    if (round > 1) {
      log(`[reconcile] Round ${round - 1} found ${failures.length} problem(s):\n  - ${failures.join('\n  - ')}`)
      log(`[reconcile] Trying again in ${roundDelayMs / 1000} s`)
      await sleep(roundDelayMs)
    }
    const result = await reconcileRound(frontend, published, drafts, log)
    if (result.failures.length === 0)
      return result.checked
    failures = result.failures
  }
  throw new Error(`[reconcile] The frontend does not serve what was synced (${RECONCILE_ROUNDS} rounds):\n  - ${failures.join('\n  - ')}`)
}

async function reconcileRound(
  frontend: URL,
  published: ReadonlyMap<string, string>,
  drafts: readonly string[],
  log: (line: string) => void,
): Promise<{ checked: number, failures: string[] }> {
  const sitemapUrl = new URL('/sitemap.xml', frontend)
  let sitemap: string
  try {
    const page = await get(sitemapUrl, log)
    if (page.status !== 200) {
      return {
        checked: 1,
        failures: [`${sitemapUrl.href} answered ${page.status}`],
      }
    }
    sitemap = new TextDecoder().decode(page.body)
  }
  catch (err) {
    return {
      checked: 1,
      failures: [
        requestFailure(sitemapUrl, err),
      ],
    }
  }

  // the sitemap holds canonical URLs; check the same paths on this frontend
  let pages: { path: string, postSlug: string | undefined }[]
  try {
    pages = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), ([, loc = '']) => {
      const path = new URL(loc).pathname
      return {
        path,
        postSlug: postSlugOf(path),
      }
    })
  }
  catch (err) {
    // an address that is no URL, or a slug that does not decode
    return {
      checked: 1,
      failures: [`${sitemapUrl.href} lists an address that cannot be read: ${messageOf(err)}`],
    }
  }
  if (pages.length === 0) {
    return {
      checked: 1,
      failures: [`${sitemapUrl.href} lists no pages`],
    }
  }

  const failures: string[] = []
  const listedPosts = new Set(pages.flatMap(page => page.postSlug ?? []))
  for (const slug of published.keys()) {
    if (!listedPosts.has(slug))
      failures.push(`${sitemapUrl.href} does not list /posts/${slug}, a published post`)
  }
  for (const slug of listedPosts) {
    if (!published.has(slug))
      failures.push(`${sitemapUrl.href} lists /posts/${slug}, which is not a published post`)
  }

  const checks: Check[] = [
    ...pages.map((page): Check => ({
      path: page.path,
      status: 200,
      hash: published.get(page.postSlug ?? ''),
    })),
    { path: '/feed.xml', status: 200 },
    ...Array.from(published.keys(), (slug): Check => ({ path: `/posts/${slug}/opengraph-image`, status: 200 })),
    ...drafts.map((slug): Check => ({ path: `/posts/${slug}`, status: 404 })),
  ]
  const queue = [...checks]
  const worker = async () => {
    for (let check = queue.shift(); check !== undefined; check = queue.shift()) {
      const failure = await runCheck(frontend, check, log)
      if (failure !== undefined)
        failures.push(failure)
    }
  }
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker))

  return { checked: checks.length + 1, failures }
}

/** What is wrong with one check's answer, if anything. Never throws. */
async function runCheck(frontend: URL, check: Check, log: (line: string) => void): Promise<string | undefined> {
  const url = new URL(check.path, frontend)
  let page: Fetched
  try {
    page = await get(url, log)
  }
  catch (err) {
    return requestFailure(url, err)
  }

  if (page.status !== check.status) {
    if (check.status === 404)
      return `${url.href} answered ${page.status}, but it is a draft and must answer 404`
    return page.status >= 500
      ? `${url.href} answered ${page.status}: the page failed to render`
      : `${url.href} answered ${page.status}, expected 200`
  }
  if (check.hash !== undefined) {
    const shown = postBodyHashesIn(new TextDecoder().decode(page.body))
    const [hash] = shown
    if (shown.length !== 1)
      return `${url.href} has ${shown.length} ${POST_BODY_HASH_META} meta tags, expected exactly one`
    if (hash !== check.hash)
      return `${url.href} still shows a previous version: expected ${POST_BODY_HASH_META} ${check.hash}, the page has ${hash}`
  }
  return undefined
}

type Fetched = {
  status: number
  body: ArrayBuffer
}

/** GET, reading the whole body within the timeout, logged. */
async function get(url: URL, log: (line: string) => void): Promise<Fetched> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await response.arrayBuffer()
  log(`[reconcile] ${response.status} ${url.pathname} x-vercel-cache=${response.headers.get('x-vercel-cache') ?? '-'} age=${response.headers.get('age') ?? '-'}`)
  return { status: response.status, body }
}

function requestFailure(url: URL, err: unknown): string {
  return err instanceof Error && err.name === 'TimeoutError'
    ? `${url.href} timed out after ${REQUEST_TIMEOUT_MS / 1000} s`
    : `${url.href} failed: ${messageOf(err)}`
}

/** The slug of a /posts/<slug> path; undefined for any other path. */
function postSlugOf(path: string): string | undefined {
  const slug = /^\/posts\/([^/]+)$/.exec(path)?.[1]
  return slug === undefined
    ? undefined
    : decodeURIComponent(slug)
}
