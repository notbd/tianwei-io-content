import type { Config } from 'drizzle-kit'
import { loadLocalEnv, readEnv } from './src/env.ts'

loadLocalEnv()

/**
 * Drizzle Kit configuration. The connection is DATABASE_URL, which only
 * the process environment can set (the deploy, or one command typed on
 * purpose; see src/env.ts). Without it there is none: `db:generate` does
 * not need a database, and `db:migrate` stops, asking for one.
 */
const url = readEnv('DATABASE_URL')

export default {
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  ...(url === undefined
    ? {}
    : {
        dbCredentials: { url },
      }),
} satisfies Config
