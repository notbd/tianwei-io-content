import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * One-time operation: rebuild the entire posts table from local content.
 */
async function runInitialSync(options?: { skipClear?: boolean }) {
  const { clearAllPosts, addAllPosts } = await import('./repository.ts')

  console.info('[services/init_sync] Starting Initial sync...')
  const skipClear = options?.skipClear ?? process.argv.includes('--skip-clear')

  if (!skipClear) {
    await clearAllPosts(true)
    console.info('[services/init_sync] Cleared posts table.')
  }
  else {
    console.info('[services/init_sync] Skipping clear (--skip-clear flag)')
  }

  const postsAdded = await addAllPosts(true)
  console.info(`[services/init_sync] Initiated ${postsAdded} posts.`)
}

/**
 * Persistent operation: watch the /content directory for changes.
 * Uses native Node fs.watch for maximum reliability.
 */
async function runContentWatcher() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { CONTENT_ROOT } = await import('./parser.ts')
  const { handleUpsert, handleDelete } = await import('./repository.ts')

  console.info('[services/watcher] Starting MDX content watcher...')
  console.info(`[services/watcher] Watching directory: `, [CONTENT_ROOT])

  /**
   * The watcher fires:
   *   - eventType "rename" → add/delete/rename
   *   - eventType "change" → file content updated
   */
  const watcher = fs.watch(CONTENT_ROOT, { recursive: true }, async (eventType, filename) => {
    if (!filename || !filename.endsWith('.mdx'))
      return

    const filePath = path.join(CONTENT_ROOT, filename)
    // random separator for easier log reading
    console.info('='.repeat(8 * (Math.floor(Math.random() * 9) + 1)))
    console.info(`[raw] ${eventType}: ${filePath}`)

    try {
      if (eventType === 'rename') {
        // rename includes add, delete, or actual move
        //   - move will trigger two events: delete old, add new
        //     so handling add and delete respectively will be sufficient
        const exists = fs.existsSync(filePath)
        if (exists) {
          // add
          await handleUpsert(filePath)
          console.info(`[services/watcher] Added: ${filename}`)
        }
        else {
          // delete
          await handleDelete(filePath)
          console.info(`[services/watcher] Deleted: ${filename}`)
        }
      }
      else if (eventType === 'change') {
        // update
        await handleUpsert(filePath)
        console.info(`[services/watcher] Updated: ${filename}`)
      }
    }
    catch (err) {
      console.error(`[services/watcher] Error processing ${filename}: \n${(err as Error).message}`)
    }
  })

  console.info('[services/watcher] Ready and initial scan complete.')
  console.info('[services/watcher] Start watching for MDX file changes...')

  /**
   * Graceful shutdown on SIGINT / SIGTERM
   */
  process.on('SIGINT', () => shutdownWatcher(watcher)) // Ctrl + C
  process.on('SIGTERM', () => shutdownWatcher(watcher))

  // Keep watching
  await new Promise(() => {})
}

async function shutdownWatcher(watcher: import('node:fs').FSWatcher) {
  console.info('\n[services/watcher] Stopping watcher and cleaning up...')
  watcher.close()

  try {
    const { pool } = await import('@/drizzle/db.ts')
    await pool.end()
    console.info('[services/watcher] Database connection closed.')
  }
  catch (err) {
    console.error('[services/watcher] Error closing DB pool:', err)
  }

  console.info('[services/watcher] Cleanup complete. Exiting.')
  console.info('\n[NOTE] Make sure to call `dev:down` to terminate db containers if needed!')
  process.exitCode = 0
}

/**
 * Combined local mode task - performs full sync, then starts watcher.
 */
async function startLocalContentService() {
  console.info('[services] Starting local content service...')
  await runInitialSync()
  await runContentWatcher()
}

// --------------------------------------------------------------
// CLI Dispatcher: allow running the file directly
// --------------------------------------------------------------

const actions = {
  runInitialSync,
  runContentWatcher,
  startLocalContentService,
} as const

type ActionName = keyof typeof actions

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const commandArg = process.argv[2] as string | undefined

  // Require a valid command argument.
  if (!commandArg || !Object.hasOwn(actions, commandArg)) {
    console.error(
      `[services] Error: You must specify a valid command (${Object.keys(actions).join(', ')})`,
    )
    process.exit(1)
  }

  const action = actions[commandArg as ActionName]
  action()
    .catch((err: unknown) => {
      console.error(`[services] Uncaught error in '${commandArg}':`, err)
      process.exit(1)
    })
}
