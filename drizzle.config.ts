import type { Config } from 'drizzle-kit'
import process from 'node:process'
import { loadLocalEnv, requireEnv } from './src/env.ts'

loadLocalEnv()

/**
 * Drizzle Kit configuration.
 * - DATABASE_URL, which only the process environment can set (the deploy,
 *   or one command typed on purpose; see src/env.ts), wins.
 * - Otherwise, the local Docker Postgres from .env.local.
 */
const remoteUrl = process.env.DATABASE_URL

export default {
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: remoteUrl
    ? { url: remoteUrl }
    : {
        host: 'localhost',
        port: Number(process.env.LOCAL_FORWARDED_DB_PORT) || 5431,
        user: requireEnv('LOCAL_POSTGRES_USER'),
        password: requireEnv('LOCAL_POSTGRES_PASSWORD'),
        database: requireEnv('LOCAL_POSTGRES_DB'),
        ssl: false,
      },
} satisfies Config
