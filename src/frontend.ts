/**
 * The content deploy's calls to the frontend: expire its content cache, then
 * prove every page renders. Kept out of the script so they can be tested.
 */
import process from 'node:process'
import { z } from 'zod'

// a hung frontend must fail the deploy step, not stall it for minutes
export const REQUEST_TIMEOUT_MS = 60_000
const PAGE_CHECK_CONCURRENCY = 4

/**
 * The production frontend. A public value, so a constant rather than a
 * secret: the deploy cannot be pointed at another environment by mistake.
 */
const PRODUCTION_FRONTEND = 'https://tianwei.io'

/** Where the frontend is, and the headers every request to it carries. */
export interface Frontend {
  url: URL
  headers: Record<string, string>
}

const extraHeaders = z.record(z.string(), z.string())

/**
 * The production frontend, unless a local rehearsal points elsewhere:
 * FRONTEND_URL (say http://localhost:3000) and FRONTEND_EXTRA_HEADERS, a
 * JSON object of headers for every request (say a Vercel protection
 * bypass). The deploy workflow sets neither.
 */
export function frontendFromEnv(): Frontend {
  const url = new URL(process.env.FRONTEND_URL || PRODUCTION_FRONTEND)
  const headersJson = process.env.FRONTEND_EXTRA_HEADERS
  if (!headersJson)
    return { url, headers: {} }
  try {
    return {
      url,
      headers: extraHeaders.parse(JSON.parse(headersJson)),
    }
  }
  catch {
    throw new Error('[env] FRONTEND_EXTRA_HEADERS must be a JSON object of strings, such as {"x-vercel-protection-bypass":"..."}')
  }
}

/**
 * POST /api/revalidate: the frontend expires the `posts` tag and re-fetches
 * the content through the API. A 207 (expired, but the re-fetch failed) is
 * a failure too.
 */
export async function revalidateFrontend(frontend: Frontend, secret: string): Promise<unknown> {
  const endpoint = new URL('/api/revalidate', frontend.url)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...frontend.headers,
      'content-type': 'application/json',
      'authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({
      tags: ['posts'],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const rawBody = await response.text()

  if (!response.ok)
    throw new Error(`[revalidate] Failed (${response.status}): ${rawBody}`)

  let payload: { success?: boolean }
  try {
    payload = JSON.parse(rawBody) as typeof payload
  }
  catch {
    // e.g. a proxy/CDN HTML error page with a 2xx status
    throw new Error(`[revalidate] Non-JSON response (${response.status}) from ${endpoint}: ${rawBody.slice(0, 300)}`)
  }

  // response.ok is true for a 207, so the payload decides
  if (payload.success !== true)
    throw new Error(`[revalidate] Partial failure (${response.status}): ${JSON.stringify(payload)}`)

  return payload
}

/**
 * Requests every page the sitemap lists and fails unless each answers 200.
 * Right after a revalidation this renders each page with the new content,
 * so a post the frontend cannot render (an MDX component it does not have,
 * a prop it rejects) turns the deploy red at once. Visitors see the error
 * too until it is fixed (the synced content has no older version to fall
 * back on); the check makes sure the author hears of it first.
 */
export async function checkEveryPage(frontend: Frontend): Promise<string[]> {
  const sitemap = await fetch(new URL('/sitemap.xml', frontend.url), {
    headers: frontend.headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!sitemap.ok)
    throw new Error(`[check] /sitemap.xml answered ${sitemap.status}`)

  // the sitemap holds canonical URLs; check the same paths on this frontend
  const paths = [
    ...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g),
  ]
    .map(([, loc]) => new URL(loc!).pathname)
  if (paths.length === 0)
    throw new Error('[check] /sitemap.xml lists no pages')

  const failures: string[] = []
  const queue = [...paths]
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        const page = await fetch(new URL(path, frontend.url), {
          headers: frontend.headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (page.status !== 200)
          failures.push(`${path} answered ${page.status}`)
      }
      catch (err) {
        failures.push(`${path} failed: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: PAGE_CHECK_CONCURRENCY }, worker))

  if (failures.length > 0)
    throw new Error(`[check] ${failures.length} of ${paths.length} pages did not render:\n  - ${failures.join('\n  - ')}`)
  return paths
}
