import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { posts } from '../../drizzle/schema.ts'
import { watchContent } from '../../src/watcher.ts'
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
    fs.rmSync(root, { recursive: true, force: true })
    root = ''
  }
  await testDb.client.close()
})

function nextSync(onSyncEvents: (() => void)[]): Promise<void> {
  return new Promise((resolve) => {
    onSyncEvents.push(resolve)
  })
}

function makeWatcher(contentRoot: string) {
  const resolvers: (() => void)[] = []
  const errors: Error[] = []
  const instance = watchContent(testDb.db, {
    contentRoot,
    debounceMs: 100,
    onSync: () => resolvers.splice(0).forEach(resolve => resolve()),
    onError: error => errors.push(error),
  })
  return { instance, resolvers, errors }
}

async function slugsInDb() {
  const rows = await testDb.db.select({ slug: posts.slug }).from(posts).orderBy(posts.slug)
  return rows.map(row => row.slug)
}

describe('watchContent', () => {
  it('reconciles adds, edits, and deletes', async () => {
    root = makeContentDir({ 'articles/existing.mdx': mdxDoc({ title: 'Existing' }) })
    const { instance, resolvers } = makeWatcher(root)
    watcher = instance
    await instance.ready

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
    root = makeContentDir({ 'articles/base.mdx': mdxDoc() })
    const syncSpy = vi.fn()
    const resolvers: (() => void)[] = []
    watcher = watchContent(testDb.db, {
      contentRoot: root,
      debounceMs: 150,
      onSync: (result) => {
        syncSpy(result)
        resolvers.splice(0).forEach(resolve => resolve())
      },
    })
    await watcher.ready

    const synced = new Promise<void>(resolve => resolvers.push(resolve))
    // burst: three quick writes + one irrelevant file
    fs.writeFileSync(path.join(root, 'articles/one.mdx'), mdxDoc({ title: 'One' }))
    fs.writeFileSync(path.join(root, 'articles/two.mdx'), mdxDoc({ title: 'Two' }))
    fs.writeFileSync(path.join(root, 'articles/notes.txt'), 'not content')
    fs.writeFileSync(path.join(root, 'articles/three.mdx'), mdxDoc({ title: 'Three' }))
    await synced

    // give any spurious extra reconcile a moment to fire, then assert one run
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(await slugsInDb()).toEqual(['base', 'one', 'three', 'two'])
  }, 15_000)

  it('keeps the old state and keeps watching after a bad save', async () => {
    root = makeContentDir({ 'articles/good.mdx': mdxDoc({ title: 'Good' }) })
    const { instance, resolvers, errors } = makeWatcher(root)
    watcher = instance
    await instance.ready

    // invalid frontmatter: reconcile must fail without touching the DB
    fs.writeFileSync(path.join(root, 'articles/broken.mdx'), mdxDoc({ title: undefined }))
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(await slugsInDb()).toEqual([]) // initial sync never ran here; DB untouched

    // fixing the file recovers on the next event
    const synced = nextSync(resolvers)
    fs.writeFileSync(path.join(root, 'articles/broken.mdx'), mdxDoc({ title: 'Fixed' }))
    await synced
    expect(await slugsInDb()).toEqual(['broken', 'good'])
  }, 15_000)
})
