import type { Db } from './sync.ts'
import type { SyncResult } from './types.ts'
import chokidar from 'chokidar'
import { CONTENT_ROOT } from './config.ts'
import { syncPosts } from './sync.ts'

export interface WatchOptions {
  contentRoot?: string
  /** Quiet window after the last file event before a reconcile runs */
  debounceMs?: number
  /** Called after every completed reconcile (used by tests and logging) */
  onSync?: (result: SyncResult) => void
  /** Called when a reconcile fails (default: console.error) */
  onError?: (error: Error) => void
}

export interface ContentWatcher {
  /** Resolves once chokidar's initial scan is done and events are live. */
  ready: Promise<void>
  close: () => Promise<void>
}

/**
 * Watch the content directory and reconcile the database on changes.
 *
 * Design: a burst of file events (editor save storms, git checkout,
 * file renames) collapses into ONE debounced full reconcile, and the
 * running/pending latch guarantees reconciles never overlap — the
 * classic out-of-order-async-writes race of per-event handlers is
 * structurally impossible. A failed reconcile (e.g. invalid frontmatter
 * mid-edit) leaves the database untouched and the watcher alive.
 */
export function watchContent(db: Db, options: WatchOptions = {}): ContentWatcher {
  const contentRoot = options.contentRoot ?? CONTENT_ROOT
  const debounceMs = options.debounceMs ?? 500
  const onError = options.onError ?? ((error: Error) => {
    console.error(`[watcher] Sync failed (database left unchanged):\n${error.message}`)
  })

  let timer: NodeJS.Timeout | undefined
  let running = false
  let pending = false
  let closed = false

  async function runReconcile(): Promise<void> {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      const result = await syncPosts(db, { contentRoot })
      console.info(`[watcher] Reconciled: ${result.upserted} upserted, ${result.deleted} deleted`)
      options.onSync?.(result)
    }
    catch (err) {
      onError(err as Error)
    }
    finally {
      running = false
      if (pending && !closed) {
        pending = false
        schedule()
      }
    }
  }

  function schedule(): void {
    if (closed)
      return
    clearTimeout(timer)
    timer = setTimeout(() => {
      void runReconcile()
    }, debounceMs)
  }

  const watcher = chokidar.watch(contentRoot, {
    ignoreInitial: true,
    // wait for writes to settle so we never read half-written files
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })

  watcher.on('all', (event, filePath) => {
    // chokidar v4 has no glob support — filter here
    if (!filePath.toLowerCase().endsWith('.mdx'))
      return
    console.info(`[watcher] ${event}: ${filePath}`)
    schedule()
  })

  watcher.on('error', (err) => {
    console.error('[watcher] Watch error:', err)
  })

  // Events fired during chokidar's initial scan are swallowed by
  // ignoreInitial — callers that mutate files right after starting the
  // watcher (tests, scripted flows) must await this first.
  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => {
      console.info(`[watcher] Watching ${contentRoot} for MDX changes...`)
      resolve()
    })
  })

  return {
    ready,
    async close() {
      closed = true
      clearTimeout(timer)
      await watcher.close()
    },
  }
}
