import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import * as schema from '../drizzle/schema.ts'
import { requireEnv } from './env.ts'

/**
 * Create a connection pool + Drizzle instance for the database
 * DATABASE_URL names: the production sync's. Local development has its
 * own, in-process database (src/localDb.ts) and never comes here.
 *
 * Deliberately a factory (no module-level pool): callers own the
 * lifecycle and must call `pool.end()` when done, and importing parsing
 * utilities never opens a database connection as a side effect.
 */
export function createDb() {
  const pool = new Pool({
    connectionString: requireEnv('DATABASE_URL'),
    // Only applies when the URL has no sslmode: pg lets the URL's
    // sslmode override this option, so DATABASE_URL must say
    // sslmode=verify-full (Neon serves public-CA certs). pg 8 still
    // verifies on 'require'; pg 9 will not (libpq semantics).
    ssl: true,
  })
  console.info('[db] Connecting to remote database')

  const db = drizzle(pool, { schema })
  return { db, pool }
}
