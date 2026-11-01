import process from 'node:process'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import * as schema from '../drizzle/schema.ts'

/**
 * Create a connection pool + Drizzle instance.
 *
 * - If DATABASE_URL is set (CI/CD, production sync), it takes precedence.
 * - Otherwise falls back to the local dockerized Postgres credentials.
 *
 * Deliberately a factory (no module-level pool): callers own the
 * lifecycle and must call `pool.end()` when done, and importing parsing
 * utilities never opens a database connection as a side effect.
 */
export function createDb() {
  const remoteUrl = process.env.DATABASE_URL

  if (remoteUrl === undefined && process.env.LOCAL_POSTGRES_USER === undefined) {
    throw new Error(
      '[db] Neither DATABASE_URL nor LOCAL_POSTGRES_* is set — '
      + 'copy .env.example to .env.local for local development.',
    )
  }

  const pool = remoteUrl
    ? new Pool({
        connectionString: remoteUrl,
        // Only applies when the URL has no sslmode: pg lets the URL's
        // sslmode override this option, so DATABASE_URL must say
        // sslmode=verify-full (Neon serves public-CA certs). pg 8 still
        // verifies on 'require'; pg 9 will not (libpq semantics).
        ssl: true,
      })
    : new Pool({
        host: 'localhost',
        port: Number(process.env.LOCAL_FORWARDED_DB_PORT) || 5431,
        user: process.env.LOCAL_POSTGRES_USER,
        password: process.env.LOCAL_POSTGRES_PASSWORD,
        database: process.env.LOCAL_POSTGRES_DB,
        ssl: false,
      })

  console.info(`[db] Connecting to ${remoteUrl ? 'remote' : 'local'} database`)

  const db = drizzle(pool, { schema })
  return { db, pool }
}
