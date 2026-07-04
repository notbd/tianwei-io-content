import { PGlite } from '@electric-sql/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { drizzle } from 'drizzle-orm/pglite'

import * as schema from '../../drizzle/schema.ts'

/**
 * Spin up an in-memory Postgres (PGlite) with the real Drizzle schema
 * applied. Real SQL semantics — ON CONFLICT, transactions, enums —
 * with zero external services.
 */
export async function createTestDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })

  const { apply } = await pushSchema(schema, db as never)
  await apply()

  return { db, client }
}
