import type { Config } from 'drizzle-kit'
import process from 'node:process'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', quiet: true })

const isProd = process.env.NODE_ENV === 'production'

export default {
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    host: 'localhost',
    port: Number(process.env.FORWARDED_DB_PORT) || 5431,
    user: process.env.POSTGRES_USER!,
    password: process.env.POSTGRES_PASSWORD!,
    database: process.env.POSTGRES_DB!,
    ssl: isProd ? { rejectUnauthorized: true } : false,
  },
} satisfies Config
