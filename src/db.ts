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
        // verify certificates (Neon serves public-CA certs);
        // rejectUnauthorized:false would silently disable TLS verification
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
