import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { text } from 'node:stream/consumers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { posts } from '../../drizzle/schema.ts'
import { openLocalDb, serveNeonHttp } from '../../src/localDb.ts'

let localDb: Awaited<ReturnType<typeof openLocalDb>>
let server: Server
let port: number
const onError = vi.fn()

beforeAll(async () => {
  localDb = await openLocalDb()
  await localDb.db.insert(posts).values(['alpha', 'beta'].map(slug => ({
    slug,
    category: 'articles',
    title: slug,
    author: 'Test Author',
    createdAt: new Date('2024-01-05T05:00:00.000Z'),
    content: 'Body.\n',
  })))
  server = await serveNeonHttp(localDb.client, 0, onError)
  port = portOf(server)
})

afterAll(async () => {
  server.close()
  server.closeAllConnections()
  await localDb.client.close()
})

function portOf(listener: { address: () => AddressInfo | string | null }): number {
  const address = listener.address()
  if (address === null || typeof address === 'string')
    throw new Error('not listening on a port')
  return address.port
}

const DRIVER_HEADER = { 'neon-connection-string': 'postgresql://local@127.0.0.1/local' }

type Answer = { status: number, body: unknown }

/** POST to the endpoint as the API's driver does, `chunks` sent one by one. */
async function post(chunks: (string | Buffer)[], headers: Record<string, string> = DRIVER_HEADER, path = '/sql'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers,
    }, (res) => {
      text(res).then((raw) => {
        resolve({
          status: res.statusCode ?? 0,
          body: raw === ''
            ? undefined
            : JSON.parse(raw),
        })
      }, reject)
    })
    req.on('error', reject)
    const [first, ...rest] = chunks
    req.write(first)
    // each later chunk in its own turn of the event loop, so it travels alone
    const sendRest = () => {
      const next = rest.shift()
      if (next === undefined) {
        req.end()
        return
      }
      req.write(next)
      setImmediate(sendRest)
    }
    setImmediate(sendRest)
  })
}

async function sql(query: string, params: (string | null)[] = []) {
  return post([
    JSON.stringify({ query, params }),
  ])
}

describe('serveNeonHttp', () => {
  it('returns every served type as the text Postgres produced, and SQL null as JSON null', async () => {
    const { status, body } = await sql(`
      select 7::int4 as i, 'v'::varchar as v, ''::text as t,
        timestamp '2024-01-05 05:00:00' as ts, false as b, null::text as n`)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      fields: [
        { name: 'i', dataTypeID: 23 },
        { name: 'v', dataTypeID: 1043 },
        { name: 't', dataTypeID: 25 },
        { name: 'ts', dataTypeID: 1114 },
        { name: 'b', dataTypeID: 16 },
        { name: 'n', dataTypeID: 25 },
      ],
      rows: [
        [
          '7',
          'v',
          '',
          '2024-01-05 05:00:00',
          'f',
          null,
        ],
      ],
      rowCount: 1,
      rowAsArray: true,
    })
  })

  it('binds parameters as the text the driver sent, leaving their meaning to Postgres', async () => {
    const tricky = 'a\\b "标题" 🚀 \'q\''
    expect(await sql('select $1::text as t, $2::int4 + 1 as n, $3::bool as b, $4::text as z', [tricky, '41', 'true', null]))
      .toMatchObject({
        status: 200,
        body: {
          rows: [
            [tricky, '42', 't', null],
          ],
        },
      })
    // a value Postgres refuses is its error, with its code, not one made up on the way in
    expect(await sql('select $1::bool as b', ['maybe'])).toEqual({
      status: 400,
      body: { message: 'invalid input syntax for type boolean: "maybe"', code: '22P02' },
    })
  })

  it('reads a character split across two chunks', async () => {
    const raw = Buffer.from(JSON.stringify({
      query: 'select $1::text as t',
      params: ['标题'],
    }))
    const middle = raw.indexOf(Buffer.from('标')) + 1
    expect(await post([
      raw.subarray(0, middle),
      raw.subarray(middle),
    ]))
      .toMatchObject({
        status: 200,
        body: {
          rows: [
            ['标题'],
          ],
        },
      })
  })

  it('counts the rows returned, or the rows affected by a statement that returns none', async () => {
    expect(await sql('select slug from posts order by slug'))
      .toMatchObject({
        status: 200,
        body: {
          rows: [
            ['alpha'],
            ['beta'],
          ],
          rowCount: 2,
        },
      })
    expect(await sql('update posts set author = $1', ['Someone']))
      .toMatchObject({
        status: 200,
        body: { rows: [], rowCount: 2 },
      })
  })

  it.each([
    ['an array', 'select array[1, 2] as a'],
    ['an array, even when its value is null', 'select null::int4[] as a'],
  ])('refuses a result with a type it does not serve: %s', async (_name, query) => {
    expect(await sql(query)).toEqual({
      status: 400,
      body: { message: 'Column "a" has a type the local database does not serve (OID 1007); it serves int4, varchar, text, timestamp, bool' },
    })
  })

  it('refuses a batch', async () => {
    expect(await post([
      JSON.stringify({
        queries: [
          { query: 'select 1', params: [] },
        ],
      }),
    ])).toEqual({
      status: 400,
      body: { message: 'The local database serves one query per request: batches and transactions are not supported' },
    })
  })

  it('answers bad SQL with a 400 that carries the Postgres error code', async () => {
    expect(await sql('selec 1')).toEqual({
      status: 400,
      body: { message: 'syntax error at or near "selec"', code: '42601' },
    })
  })

  it.each([
    ['without the driver\'s header', {}, '/sql'],
    [
      'asked by another host name',
      { ...DRIVER_HEADER, host: 'tianwei.io' },
      '/sql',
    ],
    [
      'asked by this machine\'s name with another port',
      { ...DRIVER_HEADER, host: 'localhost:1' },
      '/sql',
    ],
    ['on another path', DRIVER_HEADER, '/'],
  ])('is a 404 %s', async (_name, headers, path) => {
    expect(await post([
      JSON.stringify({ query: 'select 1', params: [] }),
    ], headers, path))
      .toEqual({ status: 404, body: undefined })
  })

  it('answers to localhost as well as 127.0.0.1', async () => {
    expect(await post([
      JSON.stringify({ query: 'select 1::int4 as n', params: [] }),
    ], { ...DRIVER_HEADER, host: `localhost:${port}` }))
      .toMatchObject({
        status: 200,
        body: {
          rows: [
            ['1'],
          ],
        },
      })
  })

  it('fails with EADDRINUSE when the port is taken on 127.0.0.1, without calling onError', async () => {
    // the holder must listen on 127.0.0.1 too: on macOS a wildcard listener does not block it
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
    const taken = portOf(holder)
    const failed = vi.fn()

    await expect(serveNeonHttp(localDb.client, taken, failed)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(failed).not.toHaveBeenCalled()
    await new Promise(resolve => holder.close(resolve))
  })

  it('hands an error after it started listening to onError', () => {
    const late = new Error('accept failed')
    // without a listener emit() itself would throw
    expect(() => server.emit('error', late)).not.toThrow()
    expect(onError).toHaveBeenCalledExactlyOnceWith(late)
  })
})
