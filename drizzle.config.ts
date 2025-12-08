import type { Config } from 'drizzle-kit'
import process from 'node:process'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', quiet: true })

/**
 * Drizzle Kit configuration.
 * - If DATABASE_URL is set (CI/CD or production), use it directly.
 * - Otherwise, fall back to local Docker Postgres credentials.
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
        user: process.env.LOCAL_POSTGRES_USER!,
        password: process.env.LOCAL_POSTGRES_PASSWORD!,
        database: process.env.LOCAL_POSTGRES_DB!,
        ssl: false,
      },
} satisfies Config
