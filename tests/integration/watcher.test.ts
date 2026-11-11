import type { MockInstance } from 'vitest'
import type { Db } from '../../src/sync.ts'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { posts } from '../../drizzle/schema.ts'
import { startWatching, watchContent } from '../../src/watcher.ts'
import { makeContentDir, mdxDoc } from '../helpers/fixture-content.ts'
import { createTestDb } from '../helpers/test-db.ts'

// Exercises the debounce + running/pending latch against a real (in-memory)
// database and a real chokidar watcher on a tmpdir.

let root = ''
let testDb: Awaited<ReturnType<typeof createTestDb>>
let watcher: ReturnType<typeof watchContent> | undefined

beforeEach(async () => {
  testDb = await createTestDb()
})

afterEach(async () => {
  await watcher?.close()
  watcher = undefined
  if (root !== '') {
    fs.chmodSync(root, 0o755)
    fs.rmSync(root, { recursive: true, force: true })
    root = ''
  }
  vi.restoreAllMocks()
  await testDb.client.close()
})

async function nextSync(onSyncEvents: (() => void)[]): Promise<void> {
  return new Promise((resolve) => {
    onSyncEvents.push(resolve)
  })
}

/** A watcher whose first reconcile has finished. */
async function makeWatcher(contentRoot: string, options: { allowEmpty?: boolean } = {}) {
  const resolvers: (() => void)[] = []
  const errors: Error[] = []
  const firstSync = nextSync(resolvers)
  const instance = watchContent(testDb.db, {
    ...options,
    contentRoot,
    debounceMs: 100,
    onSync: () => resolvers.splice(0).forEach(resolve => resolve()),
    onError: error => errors.push(error),
  })
  watcher = instance
  await instance.ready
  await firstSync
  return { resolvers, errors }
}

async function slugsInDb() {
  const rows = await testDb.db.select({ slug: posts.slug }).from(posts).orderBy(posts.slug)
  return rows.map(row => row.slug)
}

/**
 * testDb.db, except that each transaction waits until the test releases
 * it: a reconcile can be held in flight.
 */
function holdTransactions() {
  const held: (() => void)[] = []
  const db: Db = new Proxy(testDb.db, {
    get(target, property, receiver) {
      if (property !== 'transaction') {
        const value: unknown = Reflect.get(target, property, receiver)
        return value
      }
      return async (...args: Parameters<Db['transaction']>) => {
        await new Promise<void>(resolve => held.push(resolve))
        return target.transaction(...args)
      }
    },
  })
  return { db, held }
}

/** Resolves once chokidar has reported a change to an .mdx file and the debounce has run out. */
async function changeSeen(log: MockInstance<typeof console.info>) {
  await vi.waitFor(() => expect(log.mock.calls.some(args => String(args[0]).startsWith('[watcher] change:'))).toBe(true), { timeout: 10_000 })
  await sleep(300)
}

describe('watchContent', () => {
  it('reconciles once when live, then on adds, edits, and deletes', async () => {
    root = makeContentDir({
      'articles/existing.mdx': mdxDoc({ title: 'Existing' }),
    })
    const { resolvers } = await makeWatcher(root)
    expect(await slugsInDb()).toEqual(['existing'])

    let synced = nextSync(resolvers)
    fs.writeFileSync(path.join(root, 'articles/added.mdx'), mdxDoc({ title: 'Added' }))
    await synced
    expect(await slugsInDb()).toEqual(['added', 'existing'])

    synced = nextSync(resolvers)
    fs.rmSync(path.join(root, 'articles/existing.mdx'))
    await synced
    expect(await slugsInDb()).toEqual(['added'])
  }, 15_000)

  it('collapses a burst of events into one reconcile and ignores non-mdx files', async () => {
    root = makeContentDir({
      'articles/base.mdx': mdxDoc(),
    })
    const syncSpy = vi.fn()
    const resolvers: (() => void)[] = []
    const firstSync = nextSync(resolvers)
    watcher = watchContent(testDb.db, {
      contentRoot: root,
      debounceMs: 150,
      onSync: (result) => {
        syncSpy(result)
        resolvers.splice(0).forEach(resolve => resolve())
      },
    })
    await watcher.ready
    await firstSync

    const synced = nextSync(resolvers)
    // burst: three quick writes + one irrelevant file
    fs.writeFileSync(path.join(root, 'articles/one.mdx'), mdxDoc({ title: 'One' }))
    fs.writeFileSync(path.join(root, 'articles/two.mdx'), mdxDoc({ title: 'Two' }))
    fs.writeFileSync(path.join(root, 'articles/notes.txt'), 'not content')
    fs.writeFileSync(path.join(root, 'articles/three.mdx'), mdxDoc({ title: 'Three' }))
    await synced

    // give any spurious extra reconcile a moment to fire, then assert one run after the first
    await sleep(400)
    expect(syncSpy).toHaveBeenCalledTimes(2)
    expect(await slugsInDb()).toEqual(['base', 'one', 'three', 'two'])
  }, 15_000)

  it('keeps the old state and keeps watching after a bad save', async () => {
    root = makeContentDir({
      'articles/good.mdx': mdxDoc({ title: 'Good' }),
    })
    const { resolvers, errors } = await makeWatcher(root)

    // invalid frontmatter: reconcile must fail without touching the DB
    fs.writeFileSync(path.join(root, 'articles/broken.mdx'), mdxDoc({ title: undefined }))
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(await slugsInDb()).toEqual(['good'])

    // fixing the file recovers on the next event
    const synced = nextSync(resolvers)
    fs.writeFileSync(path.join(root, 'articles/broken.mdx'), mdxDoc({ title: 'Fixed' }))
    await synced
    expect(await slugsInDb()).toEqual(['broken', 'good'])
  }, 15_000)

  it('applies the entry point\'s allowEmpty to every reconcile', async () => {
    root = makeContentDir({
      'articles/only.mdx': mdxDoc(),
    })
    const { resolvers, errors } = await makeWatcher(root, { allowEmpty: true })

    // unpublishing the last post is refused without allowEmpty
    const synced = nextSync(resolvers)
    fs.writeFileSync(path.join(root, 'articles/only.mdx'), mdxDoc({ isPublished: false }))
    await synced
    expect(errors).toEqual([])
    expect(await slugsInDb()).toEqual(['only'])
  }, 15_000)

  it('does not miss a save made while the first reconcile runs', async () => {
    root = makeContentDir({
      'articles/post.mdx': mdxDoc({ title: 'Version 1' }),
    })
    const log = vi.spyOn(console, 'info')
    const { db, held } = holdTransactions()
    watcher = watchContent(db, { contentRoot: root, debounceMs: 100 })
    await watcher.ready

    // the first reconcile has parsed version 1 and waits to write it
    await vi.waitFor(() => expect(held).toHaveLength(1))
    fs.writeFileSync(path.join(root, 'articles/post.mdx'), mdxDoc({ title: 'Version 2' }))
    await changeSeen(log)
    held[0]!()

    await vi.waitFor(() => expect(held).toHaveLength(2), { timeout: 10_000 })
    held[1]!()
    await vi.waitFor(async () => {
      const [row] = await testDb.db.select({ title: posts.title }).from(posts)
      expect(row?.title).toBe('Version 2')
    })
  }, 20_000)
})

describe('startWatching', () => {
  it('fails, with the watcher and the pool closed, when the initial scan fails', async () => {
    root = makeContentDir({
      'articles/post.mdx': mdxDoc(),
    })
    fs.chmodSync(root, 0o000)
    const release = vi.fn(async () => {})
    const onSync = vi.fn()
    const onError = vi.fn()

    await expect(startWatching(testDb.db, release, { contentRoot: root, onSync, onError }))
      .rejects
      .toMatchObject({ code: 'EACCES' })
    expect(release).toHaveBeenCalledOnce()
    await sleep(500)
    expect(onSync).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  }, 15_000)

  it('stops after the reconcile in flight, never starts the queued one, and closes the pool last', async () => {
    root = makeContentDir({
      'articles/post.mdx': mdxDoc({ title: 'Version 1' }),
    })
    const log = vi.spyOn(console, 'info')
    const { db, held } = holdTransactions()
    const order: string[] = []
    const release = vi.fn(async () => {
      order.push('pool closed')
    })
    const { stop } = await startWatching(db, release, {
      contentRoot: root,
      debounceMs: 100,
      onSync: () => order.push('reconcile finished'),
    })

    // one reconcile in flight, a save queued behind it
    await vi.waitFor(() => expect(held).toHaveLength(1))
    fs.writeFileSync(path.join(root, 'articles/post.mdx'), mdxDoc({ title: 'Version 2' }))
    await changeSeen(log)

    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    await sleep(200)
    expect(stopped).toBe(false)
    expect(release).not.toHaveBeenCalled()

    held[0]!()
    await stopping
    expect(order).toEqual(['reconcile finished', 'pool closed'])
    await sleep(500)
    expect(held).toHaveLength(1)
  }, 20_000)
})
