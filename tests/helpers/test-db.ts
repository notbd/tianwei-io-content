import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import * as schema from '../../drizzle/schema.ts'

/**
 * Spin up an in-memory Postgres (PGlite) with the schema applied via the
 * COMMITTED MIGRATION CHAIN — the exact DDL production runs. This both
 * avoids drizzle-kit's semi-internal pushSchema API and means a
 * schema.ts-vs-migrations divergence fails the sync tests instead of
 * passing here and failing in prod.
 */
export async function createTestDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })

  await migrate(db, { migrationsFolder: 'drizzle/migrations' })

  return { db, client }
}
