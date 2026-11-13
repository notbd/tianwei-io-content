import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkContent, ContractUnavailableError, fetchContract, readContract } from '../../src/contract.ts'
import { parseMdxFile } from '../../src/parser.ts'
import { makeContentDir, mdxDoc } from '../helpers/fixture-content.ts'

// The frontend's /contract.json as its build serves it; replace this file
// with a fresh copy when the frontend's component table changes.
const SAMPLE: unknown = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../fixtures/contract.sample.json'), 'utf-8'))
const contract = readContract(SAMPLE)
const FRONTEND = new URL('https://preview.example.test')

let root = ''

afterEach(() => {
  vi.unstubAllGlobals()
  if (root !== '') {
    fs.rmSync(root, { recursive: true, force: true })
    root = ''
  }
})

/** Parse a post with this body against the contract (mdxDoc's body starts at line 9). */
function parseBody(body: string) {
  root = makeContentDir({
    'articles/a.mdx': mdxDoc({ body }),
  })
  return parseMdxFile(path.join(root, 'articles/a.mdx'), root, contract.components)
}

describe('readContract', () => {
  it('ignores keys it does not know, so the frontend may add some', () => {
    const extended = readContract({
      ...SAMPLE as object,
      feeds: ['/feed.xml'],
      mdx: {
        components: {
          Link: {
            attributes: { type: 'object' },
            children: true,
            since: 2,
          },
        },
        version: 2,
      },
    })
    expect([
      ...extended.components.keys(),
    ]).toEqual(['Link'])
  })
})

// The frontend's post rules test (tianwei.io src/lib/mdx.test.tsx) runs the
// same list with the same verdicts: `check:contract` and the frontend must
// agree on every one of them.
describe('the five steps against the contract', () => {
  const image = 'src="/cover.png" alt="A cover" width="1200" height="630"'

  it.each([
    ['a plain <MdxImage>', `<MdxImage ${image} />\n`],
    ['an empty <MdxImage></MdxImage>, same as self-closing', `<MdxImage ${image}></MdxImage>\n`],
    ['a <Link>', 'See <Link href="/posts">文字</Link>.\n'],
    ['a <Link> around Markdown', '<Link href="/posts">**粗体** 和 _斜体_</Link>\n'],
  ])('accepts %s', (_name, body) => {
    expect(parseBody(body).content).toBe(`\n${body}`)
  })

  it.each([
    // 1. JavaScript, fragments, member names
    ['an import', 'import x from \'y\'\n\nText\n', 'JavaScript is not allowed in posts at line 9 (mdxjsEsm)'],
    ['an export', 'export const x = 1\n\nText\n', 'JavaScript is not allowed in posts at line 9 (mdxjsEsm)'],
    ['a flow expression', '{1 + 1}\n', 'JavaScript is not allowed in posts at line 9 (mdxFlowExpression)'],
    ['an inline expression', 'Two is {1 + 1}.\n', 'JavaScript is not allowed in posts at line 9 (mdxTextExpression)'],
    ['an expression attribute', '<MdxImage src="/cover.png" alt="" width={1200} height="630" />\n', 'JavaScript is not allowed in posts at line 9 (an expression or spread prop)'],
    ['a spread attribute', '<MdxImage {...props} />\n', 'JavaScript is not allowed in posts at line 9 (an expression or spread prop)'],
    ['a fragment', '<>text</>\n', 'fragments (<>) are not allowed in posts at line 9'],
    ['a member name', '<A.B>text</A.B>\n', '<A.B> at line 9: member names are not allowed'],
    // 2. only listed components
    ['an unknown component', '<Callout>hi</Callout>\n', '<Callout> at line 9 is not a post component (the frontend\'s contract lists <MdxImage>, <Link>)'],
    ['<div style>', '<div style="x">text</div>\n', '<div> at line 9 is not a post component'],
    ['<script>', '<script>alert(1)</script>\n', '<script> at line 9 is not a post component'],
    ['<script> in a footnote definition', 'Text[^1]\n\n[^1]: <script src="x" />\n', '<script> at line 11 is not a post component'],
    // 3. no valueless attributes
    ['a valueless attribute', `<MdxImage ${image} priority />\n`, '<MdxImage> at line 9: attribute "priority" has no value'],
    // 4. every attribute, as written, through the schema
    ['a missing height', '<MdxImage src="/cover.png" alt="A cover" width="1200" />\n', '<MdxImage> at line 9: height: '],
    ['sizeCategory="huge"', `<MdxImage ${image} sizeCategory="huge" />\n`, '<MdxImage> at line 9: sizeCategory: '],
    ['an extra attribute', `<MdxImage ${image} extra="x" />\n`, '<MdxImage> at line 9: Unrecognized key: "extra"'],
    ['children="x"', `<MdxImage ${image} children="x" />\n`, '<MdxImage> at line 9: Unrecognized key: "children"'],
    ['key="x"', `<MdxImage ${image} key="x" />\n`, '<MdxImage> at line 9: Unrecognized key: "key"'],
    ['a repeated attribute', '<MdxImage width="abc" width="1" src="/cover.png" alt="A cover" height="630" />\n', '<MdxImage> at line 9: attribute "width" is given more than once'],
    // 5. no content where the component takes none
    ['an <MdxImage> with content', `<MdxImage ${image}>caption</MdxImage>\n`, '<MdxImage> at line 9 takes no content between its tags'],
  ])('refuses %s', (_name, body, reason) => {
    expect(() => parseBody(body)).toThrow(`body: ${reason}`)
  })

  it('reports the line a rule breaks on', () => {
    expect(() => parseBody('Intro\n\n<Callout>hi</Callout>\n')).toThrow('<Callout> at line 11 is not')
  })

  it('fails on a "|" inside an attribute in a table cell, a syntax error under GFM', () => {
    expect(() => parseBody('| a | b |\n| - | - |\n| <Link href="a|b">x</Link> | 2 |\n'))
      .toThrow(/body: MDX syntax error at line 11: Unexpected end of file in attribute value/)
  })
})

describe('checkContent', () => {
  it('holds drafts to the contract too, naming the file', () => {
    root = makeContentDir({
      'articles/live.mdx': mdxDoc(),
      'articles/draft.mdx': mdxDoc({ isPublished: false, body: '<Callout>soon</Callout>\n' }),
    })
    expect(() => checkContent(contract, root)).toThrow(/draft\.mdx[\s\S]*<Callout> at line 9 is not a post component/)
  })

  it('refuses a frontend that displays dates in another time zone', () => {
    root = makeContentDir({
      'articles/live.mdx': mdxDoc(),
    })
    expect(() => checkContent({ ...contract, timeZone: 'UTC' }, root))
      .toThrow('[contract] the frontend displays dates in UTC, but CONTENT_TIME_ZONE is America/New_York')
  })

  it('returns every post when all of them match', () => {
    root = makeContentDir({
      'articles/live.mdx': mdxDoc({ body: '<MdxImage src="a" alt="" width="1" height="1" />\n' }),
      'articles/draft.mdx': mdxDoc({ isPublished: false }),
    })
    expect(checkContent(contract, root).map(record => record.slug).sort()).toEqual(['draft', 'live'])
  })
})

describe('fetchContract', () => {
  function stubFetch(respond: () => Response | Promise<Response>) {
    const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) => respond())
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('reads /contract.json from the frontend it was given', async () => {
    const fetchMock = stubFetch(() => Response.json(SAMPLE))
    expect([
      ...(await fetchContract(FRONTEND)).components.keys(),
    ]).toEqual(['MdxImage', 'Link'])
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe('https://preview.example.test/contract.json')
  })

  it.each([
    [
      'a 404',
      () => new Response('not found', { status: 404 }),
    ],
    [
      'a network error',
      async () => Promise.reject(new TypeError('fetch failed')),
    ],
  ])('reports %s as no contract to give', async (_name, respond) => {
    stubFetch(respond)
    await expect(fetchContract(FRONTEND)).rejects.toBeInstanceOf(ContractUnavailableError)
  })

  it.each([
    [
      'a 500',
      () => new Response('boom', { status: 500 }),
      /answered 500: boom/,
    ],
    [
      'a document of another shape',
      () => Response.json({ timeZone: 'America/New_York' }),
      /is not a contract this engine can read/,
    ],
  ])('fails on %s, which is not a missing contract', async (_name, respond, message) => {
    stubFetch(respond)
    const result = fetchContract(FRONTEND)
    await expect(result).rejects.toThrow(message)
    await expect(result).rejects.not.toBeInstanceOf(ContractUnavailableError)
  })
})
