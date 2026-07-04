/**
 * Local development entry point.
 *
 * Default: full reconcile, then watch /content for changes.
 * Flags:
 *   --no-watch      run a single reconcile and exit
 *   --allow-empty   permit a reconcile that deletes every post
 */
import process from 'node:process'
import dotenv from 'dotenv'
import { createDb } from '../src/db.ts'
import { syncPosts } from '../src/sync.ts'
import { watchContent } from '../src/watcher.ts'

dotenv.config({ path: '.env.local', quiet: true })

async function main() {
  const watch = !process.argv.includes('--no-watch')
  const allowEmpty = process.argv.includes('--allow-empty')

  const { db, pool } = createDb()

  try {
    const result = await syncPosts(db, { allowEmpty })
    console.info(`[local-dev] Initial sync: ${result.upserted} upserted, ${result.deleted} deleted`)
  }
  catch (err) {
    console.error('[local-dev] Initial sync failed:', (err as Error).message)
    if (!watch) {
      process.exitCode = 1
      await pool.end()
      return
    }
    console.info('[local-dev] Continuing to watch — fix the content and save again.')
  }

  if (!watch) {
    await pool.end()
    return
  }

  const watcher = watchContent(db)

  const shutdown = async () => {
    console.info('\n[local-dev] Shutting down...')
    await watcher.close()
    await pool.end()
    console.info('[local-dev] Done. (Run `pnpm dev:down` to stop the DB container if needed.)')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err: unknown) => {
  console.error('[local-dev] Fatal:', err)
  process.exit(1)
})
