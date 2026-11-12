/**
 * Local development entry point: `pnpm dev`.
 *
 * Builds an in-memory database from the committed migrations, serves it to
 * the API's `wrangler dev` on 127.0.0.1:5431, then watches /content and
 * reconciles once the watcher is live and on every save. A failed
 * reconcile keeps watching: fix the content and save again. The database
 * lives as long as this process, and is rebuilt from the files each time.
 *
 * With FRONTEND_URL naming a frontend on this machine and
 * REVALIDATION_SECRET set, every sync also expires that frontend's cache,
 * as the deploy does, so a reload shows the save.
 * Flags:
 *   --allow-empty   permit a reconcile that leaves no published post
 */
import process from 'node:process'
import { loadLocalEnv, readEnv } from '../src/env.ts'
import { messageOf } from '../src/errors.ts'
import { localFrontendFromEnv, revalidateFrontend } from '../src/frontend.ts'
import { openLocalDb, serveNeonHttp } from '../src/localDb.ts'
import { startWatching } from '../src/watcher.ts'

loadLocalEnv()

// Fixed, and not read from the environment: the API's .dev.vars.example
// names this port. Taken means another `pnpm dev` runs; this one fails.
const PORT = 5431

let frontend: URL | undefined
try {
  frontend = localFrontendFromEnv()
}
catch (err) {
  // before the database is opened: nothing to release
  console.error('[dev]', messageOf(err))
  process.exit(1)
}

const { db, client } = await openLocalDb()
const server = await serveNeonHttp(client, PORT, (err) => {
  // Not shutdown(): that path exits 0. Nothing here outlives the process
  // (no lock, no files, the database is in memory), so it can just end.
  console.error('[dev] The database endpoint failed:', messageOf(err))
  process.exit(1)
}).catch(async (err: unknown) => {
  console.error(`[dev] Could not serve the database on 127.0.0.1:${PORT}:`, messageOf(err))
  await client.close()
  process.exit(1)
})
console.info(`[dev] Database ready. The API reads it with DATABASE_URL=postgresql://local@127.0.0.1:${PORT}/local`)

const secret = readEnv('REVALIDATION_SECRET')
function revalidateLocalFrontend() {
  if (frontend === undefined || secret === undefined)
    return
  revalidateFrontend(frontend, secret).then(
    () => console.info(`[dev] Revalidated ${frontend.origin}`),
    (err: unknown) => console.error(`[dev] Could not revalidate ${frontend.origin}:`, messageOf(err)),
  )
}
if (frontend !== undefined && secret !== undefined) {
  console.info(`[dev] Every sync revalidates ${frontend.origin}`)
}
else if (readEnv('FRONTEND_URL') !== undefined) {
  console.info(frontend === undefined
    ? '[dev] FRONTEND_URL is not on this machine (127.0.0.1 or localhost): no sync revalidates it'
    : '[dev] REVALIDATION_SECRET is not set: no sync revalidates the frontend')
}

async function release() {
  // the API's driver keeps its connections open; do not wait for them
  server.close()
  server.closeAllConnections()
  await client.close()
}

let stop: () => Promise<void>
try {
  ({ stop } = await startWatching(db, release, {
    allowEmpty: process.argv.includes('--allow-empty'),
    onSync: revalidateLocalFrontend,
  }))
}
catch (err) {
  console.error('[dev] Could not watch the content (watcher and database closed):', messageOf(err))
  process.exit(1)
}

// Idempotent: a second Ctrl+C while the first shutdown drains an
// in-flight reconcile must not close the database twice.
let shuttingDown = false
async function shutdown() {
  if (shuttingDown)
    return
  shuttingDown = true
  console.info('\n[dev] Shutting down...')
  try {
    await stop()
  }
  catch (err) {
    console.error('[dev] Error during shutdown:', err)
    process.exit(1)
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
