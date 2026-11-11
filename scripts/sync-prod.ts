/**
 * Production sync entry point: one transactional reconcile of the posts
 * table against the /content directory, on the database DATABASE_URL
 * names. The deploy sets it from a secret; by hand it is typed for one
 * command (`DATABASE_URL=... pnpm sync:prod`). Without it the script
 * stops instead of syncing the local database.
 */
import process from 'node:process'
import { createDb } from '../src/db.ts'
import { loadLocalEnv, requireEnv } from '../src/env.ts'
import { syncPosts } from '../src/sync.ts'

loadLocalEnv()
requireEnv('DATABASE_URL')

console.info('[sync-prod] Starting production sync...')
const { db, pool } = createDb()

try {
  const result = await syncPosts(db, {
    allowEmpty: process.argv.includes('--allow-empty'),
  })
  const deletions = result.deletedSlugs.length > 0
    ? ` (${result.deletedSlugs.join(', ')})`
    : ''
  console.info(`[sync-prod] Completed: ${result.upserted} upserted, ${result.deleted} deleted${deletions}`)
}
catch (err) {
  console.error('[sync-prod] Sync failed (database unchanged):', (err as Error).message)
  process.exitCode = 1
}
finally {
  await pool.end()
}
