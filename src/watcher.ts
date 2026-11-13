import type { Db } from './sync.ts'
import type { SyncResult } from './types.ts'
import chokidar from 'chokidar'
import { CONTENT_ROOT } from './config.ts'
import { syncPosts } from './sync.ts'

export type WatchOptions = {
  contentRoot?: string
  /** Passed to every reconcile; the entry point's --allow-empty (see SyncOptions) */
  allowEmpty?: boolean
  /** Quiet window after the last file event before a reconcile runs */
  debounceMs?: number
  /** Called after every completed reconcile (used by tests and logging) */
  onSync?: (result: SyncResult) => void
  /** Called when a reconcile fails (default: console.error) */
  onError?: (error: Error) => void
}

export type ContentWatcher = {
  /**
   * Resolves once chokidar's initial scan is done and events are live; the
   * first reconcile starts then. Rejects if the scan fails: close() the
   * watcher then (startWatching does).
   */
  ready: Promise<void>
  /**
   * Stops new reconciles and timers, then waits for the one in flight; a
   * reconcile queued behind it never starts. Safe to call more than once.
   */
  close: () => Promise<void>
}

/**
 * Watch the content directory and reconcile the database: once when the
 * watcher is live, then on changes.
 *
 * Design: the first reconcile and every burst of file events (editor save
 * storms, git checkout, file renames) go through ONE scheduler, a
 * debounced full reconcile behind a running/pending latch, so reconciles
 * never overlap; the classic out-of-order-async-writes race of per-event
 * handlers is structurally impossible. Watching starts before the first
 * reconcile, so a save made while it runs queues another instead of being
 * missed. A failed reconcile (e.g. invalid frontmatter mid-edit) leaves the
 * database untouched and the watcher alive.
 */
export function watchContent(db: Db, options: WatchOptions = {}): ContentWatcher {
  const contentRoot = options.contentRoot ?? CONTENT_ROOT
  const debounceMs = options.debounceMs ?? 500
  const onError = options.onError ?? ((error: Error) => {
    console.error(`[watcher] Sync failed (database left unchanged):\n${error.message}`)
  })

  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let pending = false
  let closed = false

  function reconcile(): void {
    if (closed)
      return
    if (running !== undefined) {
      pending = true
      return
    }
    running = (async () => {
      try {
        const result = await syncPosts(db, { contentRoot, allowEmpty: options.allowEmpty ?? false })
        console.info(`[watcher] Reconciled: ${result.upserted} upserted, ${result.deleted} deleted`)
        options.onSync?.(result)
      }
      catch (err) {
        onError(err instanceof Error
          ? err
          : new Error(String(err)))
      }
      finally {
        running = undefined
        if (pending) {
          pending = false
          schedule()
        }
      }
    })()
  }

  function schedule(): void {
    if (closed)
      return
    clearTimeout(timer)
    timer = setTimeout(reconcile, debounceMs)
  }

  const watcher = chokidar.watch(contentRoot, {
    ignoreInitial: true,
    // wait for writes to settle so we never read half-written files
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })

  watcher.on('all', (event, filePath) => {
    // chokidar has had no glob support since v4; filter here
    if (!filePath.toLowerCase().endsWith('.mdx'))
      return
    console.info(`[watcher] ${event}: ${filePath}`)
    schedule()
  })

  // chokidar reports a failed initial scan (say an unreadable content
  // directory) as an error before 'ready'; after that, errors are logged
  const ready = new Promise<void>((resolve, reject) => {
    let live = false
    watcher.on('error', (err) => {
      if (live)
        console.error('[watcher] Watch error:', err)
      else
        reject(err)
    })
    watcher.on('ready', () => {
      live = true
      resolve()
    })
  })

  // the caller hears of a failed scan through `ready`
  ready.then(() => {
    console.info(`[watcher] Watching ${contentRoot} for MDX changes...`)
    reconcile()
  }, () => {})

  let closing: Promise<void> | undefined
  async function close(): Promise<void> {
    closing ??= (async () => {
      closed = true
      clearTimeout(timer)
      pending = false
      await watcher.close()
      await running
    })()
    return closing
  }

  return { ready, close }
}

/**
 * The local dev loop: watch the content and reconcile once the watcher is
 * live and on every save. If the watcher cannot start, it closes, then
 * `release` runs (the entry point ends its pool there) and the error is
 * rethrown. stop() closes the watcher, waiting for a reconcile in flight,
 * and only then runs `release`.
 */
export async function startWatching(db: Db, release: () => Promise<void>, options: WatchOptions = {}): Promise<{ stop: () => Promise<void> }> {
  const watcher = watchContent(db, options)
  try {
    await watcher.ready
  }
  catch (err) {
    await watcher.close()
    await release()
    throw err
  }
  return {
    async stop() {
      await watcher.close()
      await release()
    },
  }
}
