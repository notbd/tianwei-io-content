import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkEveryPage, frontendFromEnv, revalidateFrontend } from '../../src/frontend.ts'

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

describe('checkEveryPage', () => {
  const sitemap = `<urlset>
<url><loc>https://tianwei.io/</loc></url>
<url><loc>https://tianwei.io/posts</loc></url>
<url><loc>https://tianwei.io/posts/hello-world</loc></url>
</urlset>`

  it('requests every sitemap path on the frontend it was given', async () => {
    const fetchMock = stubFetch(url => url.endsWith('/sitemap.xml')
      ? new Response(sitemap)
      : new Response('ok'))

    expect(await checkEveryPage(FRONTEND)).toEqual(['/', '/posts', '/posts/hello-world'])
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      'https://preview.example.test/',
      'https://preview.example.test/posts',
      'https://preview.example.test/posts/hello-world',
      'https://preview.example.test/sitemap.xml',
    ])
  })

  it('fails listing every page that did not answer 200', async () => {
    stubFetch((url) => {
      if (url.endsWith('/sitemap.xml'))
        return new Response(sitemap)
      if (url.endsWith('/hello-world'))
        return new Response('render error', { status: 500 })
      return new Response('ok')
    })
    await expect(checkEveryPage(FRONTEND)).rejects.toThrow('1 of 3 pages did not render:\n  - /posts/hello-world answered 500')
  })

  it('fails when the sitemap is missing or empty', async () => {
    stubFetch(() => new Response('nope', { status: 500 }))
    await expect(checkEveryPage(FRONTEND)).rejects.toThrow('/sitemap.xml answered 500')

    stubFetch(() => new Response('<urlset></urlset>'))
    await expect(checkEveryPage(FRONTEND)).rejects.toThrow('lists no pages')
  })
})
