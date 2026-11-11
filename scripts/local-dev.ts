/**
 * Local development entry point.
 *
 * Default: watch /content, then reconcile once the watcher is live and on
 * every save. A failed reconcile keeps watching: fix the content and save
 * again. If the watcher cannot start, the script closes everything and
 * fails.
 * Flags:
 *   --no-watch      run a single reconcile and exit
 *   --allow-empty   permit a reconcile that leaves no published post (every
 *                   reconcile, the watcher's too)
 */
import process from 'node:process'
import { createDb } from '../src/db.ts'
import { loadLocalEnv } from '../src/env.ts'
import { messageOf } from '../src/errors.ts'
import { syncPosts } from '../src/sync.ts'
import { startWatching } from '../src/watcher.ts'

loadLocalEnv()

const allowEmpty = process.argv.includes('--allow-empty')
const { db, pool } = createDb()

if (process.argv.includes('--no-watch')) {
  try {
    const result = await syncPosts(db, { allowEmpty })
    console.info(`[local-dev] Synced: ${result.upserted} upserted, ${result.deleted} deleted`)
  }
  catch (err) {
    console.error('[local-dev] Sync failed (database unchanged):', messageOf(err))
    process.exitCode = 1
  }
  finally {
    await pool.end()
  }
}
else {
  let stop: () => Promise<void>
  try {
    ({ stop } = await startWatching(db, async () => pool.end(), { allowEmpty }))
  }
  catch (err) {
    console.error('[local-dev] Could not watch the content (watcher and database closed):', messageOf(err))
    process.exit(1)
  }

  // Idempotent: a second Ctrl+C while the first shutdown drains an
  // in-flight reconcile must not re-enter pool.end() (which rejects on
  // repeat calls and would crash the process with an unhandled rejection).
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown)
      return
    shuttingDown = true
    console.info('\n[local-dev] Shutting down...')
    try {
      await stop()
    }
    catch (err) {
      console.error('[local-dev] Error during shutdown:', err)
      process.exit(1)
    }
    console.info('[local-dev] Done. (Run `pnpm dev:down` to stop the DB container if needed.)')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
