import process from 'node:process'
import dotenv from 'dotenv'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import * as schema from './schema.ts'

dotenv.config({ path: '.env.local', quiet: true })

export const pool = new Pool({
  host: 'localhost',
  port: Number(process.env.FORWARDED_DB_PORT) || 5431,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
})

export const db = drizzle(pool, { schema })
export type DB = typeof db
