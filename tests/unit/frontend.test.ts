import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { frontendFromEnv, postBodyHash, postBodyHashIn, reconcile, revalidateFrontend } from '../../src/frontend.ts'
import { makeContentDir, mdxDoc } from '../helpers/fixture-content.ts'

const FRONTEND = {
  url: new URL('https://preview.example.test'),
  headers: { 'x-rehearsal': 'yes' },
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('frontendFromEnv', () => {
  it('is production unless a rehearsal sets FRONTEND_URL and FRONTEND_EXTRA_HEADERS', () => {
    vi.stubEnv('FRONTEND_URL', undefined)
    vi.stubEnv('FRONTEND_EXTRA_HEADERS', undefined)
    expect(frontendFromEnv()).toEqual({
      url: new URL('https://tianwei.io'),
      headers: {},
    })

    vi.stubEnv('FRONTEND_URL', 'http://localhost:3000')
    vi.stubEnv('FRONTEND_EXTRA_HEADERS', '{"x-vercel-protection-bypass":"abc"}')
    expect(frontendFromEnv()).toEqual({
      url: new URL('http://localhost:3000'),
      headers: { 'x-vercel-protection-bypass': 'abc' },
    })
  })

  it('refuses extra headers that are not a JSON object of strings', () => {
    vi.stubEnv('FRONTEND_EXTRA_HEADERS', '{"x-count":1}')
    expect(() => frontendFromEnv()).toThrow('[env] FRONTEND_EXTRA_HEADERS must be a JSON object of strings')
  })
})

describe('revalidateFrontend', () => {
  it('posts the posts tag with the bearer secret and returns the payload', async () => {
    const fetchMock = stubFetch(() => Response.json({
      success: true,
      revalidated: ['posts'],
    }))

    expect(await revalidateFrontend(FRONTEND, 's3cret')).toEqual({
      success: true,
      revalidated: ['posts'],
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://preview.example.test/api/revalidate')
    expect(init).toMatchObject({
      method: 'POST',
      body: '{"tags":["posts"]}',
      headers: { 'authorization': 'Bearer s3cret', 'x-rehearsal': 'yes' },
    })
  })

  it.each([
    [
      'a 401',
      () => new Response('{"error":"Unauthorized"}', { status: 401 }),
      /Failed \(401\)/,
    ],
    [
      'a 502, where the frontend read the API, failed, and expired nothing',
      () => Response.json({ error: 'Bad Gateway', message: 'api down' }, { status: 502 }),
      /could not read the API, so it expired nothing.*\(502\)/,
    ],
    [
      'a 207 from a frontend that still warms after expiring',
      () => Response.json({ success: false, error: 'api down' }, { status: 207 }),
      /Failed \(207\)/,
    ],
    [
      'a 200 whose revalidated does not list posts',
      () => Response.json({ success: true, revalidated: [] }),
      /200 without "posts" in revalidated/,
    ],
    [
      'a 200 HTML page',
      () => new Response('<html>proxy</html>', { status: 200 }),
      /Non-JSON response \(200\)/,
    ],
  ])('fails the deploy on %s', async (_name, respond, message) => {
    stubFetch(respond)
    await expect(revalidateFrontend(FRONTEND, 's3cret')).rejects.toThrow(message)
  })
})

describe('postBodyHash', () => {
  it('matches the frontend on a fixed text (CJK, emoji, CRLF, trailing newline)', () => {
    // the same text and hex are pinned in tianwei.io src/lib/postBodyHash.test.ts
    expect(postBodyHash('标题 🚀\r\n第二行 café\n')).toBe('9e991956f3864def377864042db5e9bfdbad7d31c1d373e19e8d8a98e35b2609')
  })
})

describe('postBodyHashIn', () => {
  const hash = 'ab'.repeat(32)

  it.each([
    ['in <head>', `<html><head><meta charSet="utf-8"/><meta name="post-body-sha256" content="${hash}"/></head></html>`],
    ['in <body>, content first, single quotes', `<body><p>x</p><META content='${hash}' name='post-body-sha256'></body>`],
  ])('reads the tag %s', (_name, html) => {
    expect(postBodyHashIn(html)).toBe(hash)
  })

  it('ignores other meta tags and any other 64-digit hex on the page', () => {
    expect(postBodyHashIn(`<meta name="description" content="${hash}"><p>${hash}</p>`)).toBeUndefined()
  })
})

describe('reconcile', () => {
  let root = ''

  afterEach(() => {
    if (root !== '') {
      fs.rmSync(root, { recursive: true, force: true })
      root = ''
    }
  })

  // two published posts and a draft; mdxDoc puts a blank line before the body
  function makeContent() {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc({ body: 'Alpha.\n' }),
      'articles/beta.mdx': mdxDoc({ body: 'Beta.\n' }),
      'articles/gamma.mdx': mdxDoc({ isPublished: false, body: 'Draft.\n' }),
    })
  }

  const postPage = (body: string | undefined) => () => new Response(body === undefined
    ? '<html><body>no meta</body></html>'
    : `<html><head><meta name="post-body-sha256" content="${postBodyHash(`\n${body}`)}"/></head><body>…</body></html>`)

  function sitemap(...paths: string[]) {
    return () => new Response(`<urlset>${paths.map(p => `<url><loc>https://tianwei.io${p}</loc></url>`).join('')}</urlset>`)
  }

  type Page = () => Response | Promise<Response>
  const site: Record<string, Page> = {
    '/sitemap.xml': sitemap('/', '/posts', '/posts/alpha', '/posts/beta'),
    '/': () => new Response('home'),
    '/posts': () => new Response('list'),
    '/posts/alpha': postPage('Alpha.\n'),
    '/posts/beta': postPage('Beta.\n'),
    '/feed.xml': () => new Response('<rss/>'),
    '/posts/alpha/opengraph-image': () => new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47])),
    '/posts/beta/opengraph-image': () => new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47])),
    '/posts/gamma': () => new Response('not found', { status: 404 }),
  }

  /** Serve `site` with `changes` on top, and record every path requested. */
  function serve(changes: Record<string, Page> = {}) {
    const pages = {
      ...site,
      ...changes,
    }
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = new URL(input)
      requested.push(url.pathname)
      const response = await (pages[url.pathname] ?? (() => new Response('missing', { status: 404 })))()
      response.headers.set('x-vercel-cache', 'HIT')
      response.headers.set('age', '7')
      return response
    }))
    return requested
  }

  const run = (log: (line: string) => void = () => {}) => reconcile(FRONTEND, { contentRoot: root, roundDelayMs: 0, log })

  it('passes when the sitemap, every page, the feed, the images and the drafts all match', async () => {
    makeContent()
    const requested = serve()
    const lines: string[] = []

    expect(await run(line => lines.push(line))).toBe(9)
    expect(requested.toSorted()).toEqual([
      '/',
      '/feed.xml',
      '/posts',
      '/posts/alpha',
      '/posts/alpha/opengraph-image',
      '/posts/beta',
      '/posts/beta/opengraph-image',
      '/posts/gamma',
      '/sitemap.xml',
    ])
    expect(lines).toContain('[reconcile] 200 /posts/alpha x-vercel-cache=HIT age=7')
  })

  it('reports a post page still showing the previous version, after three rounds', async () => {
    makeContent()
    const requested = serve({
      '/posts/alpha': postPage('Old alpha.\n'),
    })

    await expect(run()).rejects.toThrow(
      `/posts/alpha still shows a previous version: expected post-body-sha256 ${postBodyHash('\nAlpha.\n')}, the page has ${postBodyHash('\nOld alpha.\n')}`,
    )
    expect(requested.filter(p => p === '/sitemap.xml')).toHaveLength(3)
  })

  it('reports a post page without the hash', async () => {
    makeContent()
    serve({
      '/posts/beta': postPage(undefined),
    })
    await expect(run()).rejects.toThrow('/posts/beta still shows a previous version: expected post-body-sha256 ')
    await expect(run()).rejects.toThrow('the page has no such meta tag')
  })

  it('tells a failed render, a timeout and a missing page apart', async () => {
    makeContent()
    serve({
      '/posts/beta': () => new Response('error', { status: 500 }),
      '/feed.xml': () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      '/posts/alpha/opengraph-image': () => new Response('missing', { status: 404 }),
    })
    const result = run()
    await expect(result).rejects.toThrow('https://preview.example.test/posts/beta answered 500: the page failed to render')
    await expect(result).rejects.toThrow('https://preview.example.test/feed.xml timed out after 60 s')
    await expect(result).rejects.toThrow('https://preview.example.test/posts/alpha/opengraph-image answered 404, expected 200')
  })

  it('requires the sitemap to list exactly the published posts', async () => {
    makeContent()
    serve({
      '/sitemap.xml': sitemap('/', '/posts/alpha', '/posts/gamma'),
    })
    const result = run()
    await expect(result).rejects.toThrow('/sitemap.xml does not list /posts/beta, a published post')
    await expect(result).rejects.toThrow('/sitemap.xml lists /posts/gamma, which is not a published post')
  })

  it('requires every draft to answer 404', async () => {
    makeContent()
    serve({
      '/posts/gamma': () => new Response('a draft, in public'),
    })
    await expect(run()).rejects.toThrow('/posts/gamma answered 200, but it is a draft and must answer 404')
  })

  it('reads every body to the end: a 200 whose body breaks is a failure', async () => {
    makeContent()
    serve({
      '/posts/alpha': () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error('body disconnected'))
        },
      })),
    })
    await expect(run()).rejects.toThrow('/posts/alpha failed: body disconnected')
  })

  it('passes on a later round, comparing against the content as it was on entry', async () => {
    makeContent()
    let feedAnswers = 0
    const requested = serve({
      '/feed.xml': () => {
        // the author saves a new version while the first round runs: the
        // reconcile must keep comparing against what was synced
        fs.writeFileSync(path.join(root, 'articles/alpha.mdx'), mdxDoc({ body: 'Alpha, edited.\n' }))
        return new Response('<rss/>', {
          status: feedAnswers++ === 0
            ? 500
            : 200,
        })
      },
    })

    expect(await run()).toBe(9)
    expect(requested.filter(p => p === '/sitemap.xml')).toHaveLength(2)
  })

  it('starts a round only when the last one has nothing in flight, with at most 4 requests at once', async () => {
    makeContent()
    let inFlight = 0
    let mostInFlight = 0
    const inFlightAtEachSitemap: number[] = []
    let slowAnswers = 0
    const paths = Array.from({ length: 9 }, (_, i) => `/page-${i}`)
    const pages: Record<string, Page> = {
      '/sitemap.xml': sitemap('/posts/alpha', '/posts/beta', '/slow', ...paths),
      '/slow': () => new Response('slow', {
        status: slowAnswers++ === 0
          ? 500
          : 200,
      }),
      ...Object.fromEntries(paths.map(p => [
        p,
        () => new Response(p),
      ])),
    }
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const { pathname } = new URL(input)
      if (pathname === '/sitemap.xml')
        inFlightAtEachSitemap.push(inFlight)
      inFlight++
      mostInFlight = Math.max(mostInFlight, inFlight)
      const response = await (pages[pathname] ?? site[pathname]!)()
      const text = await response.text()
      // the body arrives later; the slow page's arrives last
      const delayMs = pathname === '/slow'
        ? 60
        : 5
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, delayMs))
          controller.enqueue(new TextEncoder().encode(text))
          inFlight--
          controller.close()
        },
      }), { status: response.status })
    }))

    expect(await run()).toBe(17)
    expect(inFlightAtEachSitemap).toEqual([0, 0])
    expect(mostInFlight).toBe(4)
  })
})
