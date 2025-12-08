import { execSync } from 'node:child_process'
import process from 'node:process'
import dotenv from 'dotenv'

/**
 * Self-contained test script for remote database sync.
 *
 * This script:
 *   1. Loads REMOTE_DATABASE_URL from .env.local
 *   2. Pushes schema to remote database
 *   3. Runs the full sync
 *   4. Verifies data was written correctly
 *
 * Usage: pnpm test:remote
 */
async function main() {
  // Load env first
  dotenv.config({ path: '.env.local' })

  const remoteUrl = process.env.REMOTE_DATABASE_URL

  if (!remoteUrl) {
    console.error('[test] REMOTE_DATABASE_URL is not set in .env.local')
    console.error('[test] Add your remote connection string and try again.')
    process.exit(1)
  }

  // Mask password for logging
  const maskedUrl = remoteUrl.replace(/:[^:@]+@/, ':****@')
  console.info('[test] Target database:', maskedUrl)

  // Set DATABASE_URL so all subsequent imports use remote connection
  process.env.DATABASE_URL = remoteUrl

  // Step 1: Push schema
  console.info('[test] Pushing schema to remote database...')
  try {
    execSync('pnpm drizzle-kit push', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: remoteUrl },
    })
  }
  catch {
    console.error('[test] Schema push failed')
    process.exit(1)
  }

  // Step 2: Run sync (import dynamically after DATABASE_URL is set)
  console.info('[test] Starting content sync...')
  const { pool } = await import('@/drizzle/db.ts')
  const { clearAllPosts, addAllPosts } = await import('@/scripts/repository.ts')

  try {
    await clearAllPosts()
    console.info('[test] Cleared existing posts')

    const count = await addAllPosts()
    console.info(`[test] Synced ${count} posts`)

    // Step 3: Verify
    console.info('[test] Verifying data...')
    const { db } = await import('@/drizzle/db.ts')
    const { posts } = await import('@/drizzle/schema.ts')

    const rows = await db
      .select({ slug: posts.slug, title: posts.title, category: posts.category })
      .from(posts)

    if (rows.length === 0) {
      console.error('[test] Verification failed: no posts found in database')
      process.exitCode = 1
    }
    else {
      console.info('[test] Posts in remote database:')
      for (const row of rows) {
        console.info(`  [${row.category}] ${row.slug}: ${row.title}`)
      }
      console.info(`[test] Verification passed: ${rows.length} posts found`)
    }
  }
  catch (err) {
    console.error('[test] Sync failed:', err)
    process.exitCode = 1
  }
  finally {
    await pool.end()
    console.info('[test] Database connection closed')
  }
}

main()
