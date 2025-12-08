import process from 'node:process'
import { pool } from '@/drizzle/db.ts'
import { addAllPosts, clearAllPosts } from '@/scripts/repository.ts'

async function main() {
  console.info('[sync-prod] Starting production sync...')

  try {
    // Step 1: Clear existing posts
    await clearAllPosts()
    console.info('[sync-prod] Cleared all posts from database.')

    // Step 2: Parse and insert all posts from filesystem
    const count = await addAllPosts()
    console.info(`[sync-prod] Synced ${count} posts to database.`)

    console.info('[sync-prod] Sync completed successfully.')
  }
  catch (err) {
    console.error('[sync-prod] Sync failed:', err)
    process.exitCode = 1
  }
  finally {
    // Always close the pool to allow process to exit
    await pool.end()
    console.info('[sync-prod] Database connection closed.')
  }
}

main()
