/**
 * The local database: an in-process Postgres (PGlite) built from the
 * committed migrations, and an endpoint that serves it to the API's driver.
 * `pnpm dev` and the integration tests use it.
 *
 * What the endpoint keeps out: it listens on 127.0.0.1 only, so no other
 * machine reaches it, and it answers only requests that name this machine
 * as their host and carry a header a web page cannot send without a
 * preflight (which goes unanswered), so no ordinary web page does either.
 * What it does not keep out: every process on this machine can read and
 * write the database. It is in memory, holds no credentials and has no
 * route to the production database.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import path from 'node:path'
import { json } from 'node:stream/consumers'
import { PGlite, types } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { z } from 'zod'

import * as schema from '../drizzle/schema.ts'
import { messageOf } from './errors.ts'

const MIGRATIONS = path.join(import.meta.dirname, '../drizzle/migrations')

/**
 * An in-memory Postgres with the committed migration chain applied: the
 * DDL production runs, so a schema that drifted from its migrations fails
 * here. It lives until the caller closes `client`; a failed migration
 * closes it before the error leaves.
 */
export async function openLocalDb() {
  const client = new PGlite()
  try {
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: MIGRATIONS })
    return { db, client }
  }
  catch (err) {
    await client.close()
    throw err
  }
}

/**
 * The column types the endpoint serves: the ones the posts table has. A
 * result with any other type is refused, by the column's type and not its
 * value, so nothing is ever handed on half-converted. A new column type
 * gets a line here and a row in the endpoint's test.
 */
const SERVED_TYPES = new Map<number, string>([
  [types.INT4, 'int4'],
  [types.VARCHAR, 'varchar'],
  [types.TEXT, 'text'],
  [types.TIMESTAMP, 'timestamp'],
  [types.BOOL, 'bool'],
])

// Text in, text out: the driver sends every parameter as text and parses
// every value itself, so nothing here builds a Date or moves a time zone.
const asText = (text: string) => text
const AS_TEXT = Object.fromEntries(Object.values(types).flatMap((oid): [number, typeof asText][] =>
  // the module exports its converters next to the type OIDs
  typeof oid === 'number'
    ? [
        [oid, asText],
      ]
    : []))

const sqlRequestSchema = z.object({
  query: z.string(),
  params: z.array(z.string().nullable()),
})

/**
 * Serve the database over Neon's HTTP protocol, the one the API's driver
 * speaks in production, so `wrangler dev` reads it with
 * DATABASE_URL=postgresql://local@127.0.0.1:<port>/local. Only the part
 * the API uses, and everything else is refused rather than guessed at:
 * - POST /sql with a Host of 127.0.0.1:<port> or localhost:<port> and the
 *   driver's Neon-Connection-String header; anything else is a 404.
 * - One query per request. A batch or a transaction ({ queries }) is a 400.
 * - Parameters are bound as the text (or null) the driver sent, and values
 *   are returned as the text Postgres produced, for the SERVED_TYPES only.
 * - `rowCount` is the number of rows of a statement that returns rows, and
 *   the number of rows affected of one that does not.
 * - An error is a 400 with { message, code }, a subset of Neon's error
 *   body: the two fields the driver's error always carries.
 *
 * Resolves once it listens. An error before that rejects with that error
 * (the server never held the port, so there is nothing to close); an error
 * after it goes to `onError`, since the caller has moved on by then.
 */
export async function serveNeonHttp(client: PGlite, port: number, onError: (err: Error) => void): Promise<Server> {
  // set when the server listens: the two names this machine is asked by
  let hosts: ReadonlySet<string> = new Set()

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: object) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json' }).end(text)
    }
    // One try around everything: a client that hangs up mid-request fails
    // this request, not the process through an unhandled rejection.
    try {
      if (
        req.method !== 'POST'
        || req.url !== '/sql'
        || !hosts.has(req.headers.host ?? '')
        || req.headers['neon-connection-string'] === undefined
      ) {
        res.writeHead(404).end()
        return
      }

      // json() decodes the whole body at once, so a character split across
      // two chunks arrives intact
      const body = await json(req)
      if (typeof body === 'object' && body !== null && 'queries' in body) {
        reply(400, { message: 'The local database serves one query per request: batches and transactions are not supported' })
        return
      }
      const request = sqlRequestSchema.safeParse(body)
      if (!request.success) {
        reply(400, { message: `Expected { query, params } with text or null parameters: ${z.prettifyError(request.error)}` })
        return
      }

      const result = await client.query<string[]>(request.data.query, request.data.params, {
        rowMode: 'array',
        parsers: AS_TEXT,
        serializers: AS_TEXT,
      })
      const unserved = result.fields.find(field => !SERVED_TYPES.has(field.dataTypeID))
      if (unserved !== undefined) {
        reply(400, { message: `Column "${unserved.name}" has a type the local database does not serve (OID ${unserved.dataTypeID}); it serves ${Array.from(SERVED_TYPES.values()).join(', ')}` })
        return
      }
      reply(200, {
        fields: result.fields,
        rows: result.rows,
        command: result.command,
        rowCount: result.fields.length > 0
          ? result.rows.length
          : result.affectedRows ?? 0,
        rowAsArray: true,
      })
    }
    catch (err) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      reply(400, {
        message: messageOf(err),
        code: err instanceof Error && 'code' in err
          ? err.code
          : undefined,
      })
    }
  }

  const server = createServer((req, res) => void answer(req, res))
  return new Promise((resolve, reject) => {
    // The one error listener for the server's whole life, attached before
    // listen(). Which way an error goes changes inside the listen callback,
    // before the caller gets the server, so no error falls between the two.
    let listening = false
    server.on('error', (err) => {
      if (listening)
        onError(err)
      else
        reject(err)
    })
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address !== null)
        hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`])
      listening = true
      resolve(server)
    })
  })
}
