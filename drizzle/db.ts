import process from 'node:process'
import dotenv from 'dotenv'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import * as schema from './schema.ts'

// Load .env.local for local development (no-op if file doesn't exist)
dotenv.config({ path: '.env.local', quiet: true })

/**
 * Create a connection pool.
 * - Production: uses DATABASE_URL (set by CI/CD or hosting env)
 * - Local: uses individual env vars for dockerized postgres
 */
function createPool(): Pool {
  // DATABASE_URL takes precedence (set by CI/CD or test scripts)
  const remoteUrl = process.env.DATABASE_URL

  if (remoteUrl) {
    console.info('[db] Connecting to remote database')
    return new Pool({
      connectionString: remoteUrl,
      ssl: { rejectUnauthorized: false },
    })
  }

  console.info('[db] Connecting to local database')
  return new Pool({
    host: 'localhost',
    port: Number(process.env.LOCAL_FORWARDED_DB_PORT) || 5431,
    user: process.env.LOCAL_POSTGRES_USER,
    password: process.env.LOCAL_POSTGRES_PASSWORD,
    database: process.env.LOCAL_POSTGRES_DB,
    ssl: false,
  })
}

export const pool = createPool()
export const db = drizzle(pool, { schema })
export type DB = typeof db
