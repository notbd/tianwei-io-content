/**
 * Production sync entry point (run by CI with DATABASE_URL set).
 * Performs a single transactional reconcile of the posts table
 * against the /content directory.
 */
import process from 'node:process'
import dotenv from 'dotenv'
import { createDb } from '../src/db.ts'
import { syncPosts } from '../src/sync.ts'

dotenv.config({ path: '.env.local', quiet: true })

async function main() {
  console.info('[sync-prod] Starting production sync...')
  const { db, pool } = createDb()

  try {
    const result = await syncPosts(db, {
      allowEmpty: process.argv.includes('--allow-empty'),
    })
    const deletions = result.deletedSlugs.length > 0 ? ` (${result.deletedSlugs.join(', ')})` : ''
    console.info(`[sync-prod] Completed: ${result.upserted} upserted, ${result.deleted} deleted${deletions}`)
  }
  catch (err) {
    console.error('[sync-prod] Sync failed (database unchanged):', (err as Error).message)
    process.exitCode = 1
  }
  finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error('[sync-prod] Fatal:', err)
  process.exitCode = 1
})
