import fs from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../drizzle/schema.ts'
import { posts } from '../../drizzle/schema.ts'
import { openLocalDb } from '../../src/localDb.ts'
import { syncPosts } from '../../src/sync.ts'
import { makeContentDir, mdxDoc } from '../helpers/fixture-content.ts'

let root = '' // '' = not created; guards afterEach when makeContentDir throws
let testDb: Awaited<ReturnType<typeof openLocalDb>>

beforeEach(async () => {
  testDb = await openLocalDb()
})

afterEach(async () => {
  if (root !== '') {
    fs.rmSync(root, { recursive: true, force: true })
    root = ''
  }
  await testDb.client.close()
})

async function allRows() {
  return testDb.db.select().from(posts).orderBy(posts.slug)
}

describe('syncPosts', () => {
  it('inserts every parsed post on a fresh sync', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc({ title: 'Alpha', createdAt: '2024-01-05', isPublished: true }),
      'articles/beta.mdx': mdxDoc({ title: 'Beta', createdAt: '2024-02-06', isPublished: false }),
    })

    const result = await syncPosts(testDb.db, { contentRoot: root })
    expect(result).toEqual({ upserted: 2, deleted: 0, deletedSlugs: [] })

    const rows = await allRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      slug: 'alpha',
      category: 'articles',
      title: 'Alpha',
      author: 'Test Author',
      isPublished: true,
      createdAt: new Date(Date.UTC(2024, 0, 5, 5)), // EST midnight
      // updatedAt is optional: absent in frontmatter means NULL in the DB
      updatedAt: null,
    })
    // unpublished posts are stored too: visibility filtering is the API's job
    expect(rows[1]).toMatchObject({ slug: 'beta', isPublished: false })
  })

  it('round-trips updatedAt when present, and clears it when removed', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc({ createdAt: '2024-01-05', updatedAt: '2024-02-01' }),
    })
    await syncPosts(testDb.db, { contentRoot: root })
    let [row] = await allRows()
    expect(row).toMatchObject({
      updatedAt: new Date(Date.UTC(2024, 1, 1, 5)),
    }) // EST midnight

    // removing the field from frontmatter must null the column on re-sync
    fs.writeFileSync(path.join(root, 'articles/alpha.mdx'), mdxDoc({ createdAt: '2024-01-05' }))
    await syncPosts(testDb.db, { contentRoot: root });
    [row] = await allRows()
    expect(row).toMatchObject({ updatedAt: null })
  })

  it('is idempotent and preserves ids across re-runs', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc({ title: 'Alpha' }),
      'articles/beta.mdx': mdxDoc({ title: 'Beta' }),
    })

    await syncPosts(testDb.db, { contentRoot: root })
    const before = await allRows()

    const second = await syncPosts(testDb.db, { contentRoot: root })
    expect(second).toEqual({ upserted: 2, deleted: 0, deletedSlugs: [] })

    const after = await allRows()
    // the legacy clear+reinsert churned serial ids on every deploy
    expect(after).toEqual(before)
  })

  it('updates changed posts in place', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc({ title: 'Alpha' }),
    })
    await syncPosts(testDb.db, { contentRoot: root })
    const [original] = await allRows()

    fs.writeFileSync(
      path.join(root, 'articles/alpha.mdx'),
      mdxDoc({ title: 'Alpha v2', description: 'updated', body: 'New body.\n' }),
    )
    await syncPosts(testDb.db, { contentRoot: root })

    const [updated] = await allRows()
    expect(original).toBeDefined()
    expect(updated).toMatchObject({
      id: original?.id,
      title: 'Alpha v2',
      description: 'updated',
      content: '\nNew body.\n',
    })
  })

  it('deletes rows whose files were removed', async () => {
    root = makeContentDir({
      'articles/keep.mdx': mdxDoc(),
      'articles/remove.mdx': mdxDoc(),
    })
    await syncPosts(testDb.db, { contentRoot: root })

    fs.rmSync(path.join(root, 'articles/remove.mdx'))
    const result = await syncPosts(testDb.db, { contentRoot: root })

    expect(result.deleted).toBe(1)
    expect(result.deletedSlugs).toEqual(['remove'])
    expect((await allRows()).map(row => row.slug)).toEqual(['keep'])
  })

  it('handles file renames without leaving orphaned rows', async () => {
    root = makeContentDir({
      'articles/old-name.mdx': mdxDoc(),
    })
    await syncPosts(testDb.db, { contentRoot: root })

    fs.renameSync(
      path.join(root, 'articles/old-name.mdx'),
      path.join(root, 'articles/new-name.mdx'),
    )
    const result = await syncPosts(testDb.db, { contentRoot: root })

    expect(result.deletedSlugs).toEqual(['old-name'])
    expect((await allRows()).map(row => row.slug)).toEqual(['new-name'])
  })

  it('leaves the database untouched when any file is invalid', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc({ title: 'Alpha' }),
    })
    await syncPosts(testDb.db, { contentRoot: root })
    const before = await allRows()

    fs.writeFileSync(path.join(root, 'articles/broken.mdx'), mdxDoc({ title: undefined }))
    await expect(syncPosts(testDb.db, { contentRoot: root })).rejects.toThrow(/failed to parse/)

    expect(await allRows()).toEqual(before)
  })

  it('refuses an empty reconcile unless allowEmpty is set', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc(),
    })
    await syncPosts(testDb.db, { contentRoot: root })

    fs.rmSync(path.join(root, 'articles/alpha.mdx'))
    // guard: an empty parse must never silently wipe the table
    await expect(syncPosts(testDb.db, { contentRoot: root })).rejects.toThrow(/Refusing to reconcile/)
    expect(await allRows()).toHaveLength(1)

    const result = await syncPosts(testDb.db, { contentRoot: root, allowEmpty: true })
    expect(result.deletedSlugs).toEqual(['alpha'])
    expect(await allRows()).toHaveLength(0)
  })

  it('refuses a reconcile that leaves only drafts unless allowEmpty is set', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc(),
    })
    await syncPosts(testDb.db, { contentRoot: root })

    // unpublishing the last post empties the site as surely as deleting it
    fs.writeFileSync(path.join(root, 'articles/alpha.mdx'), mdxDoc({ isPublished: false }))
    await expect(syncPosts(testDb.db, { contentRoot: root })).rejects.toThrow('no published post under')
    expect(await allRows()).toMatchObject([
      { slug: 'alpha', isPublished: true },
    ])

    await syncPosts(testDb.db, { contentRoot: root, allowEmpty: true })
    expect(await allRows()).toMatchObject([
      { slug: 'alpha', isPublished: false },
    ])
  })

  it('rejects duplicate slugs before touching the database', async () => {
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc({ title: 'Original' }),
    })
    await syncPosts(testDb.db, { contentRoot: root })

    // second category with the same filename → same slug
    fs.mkdirSync(path.join(root, 'articles2'))
    fs.writeFileSync(path.join(root, 'articles2/alpha.mdx'), mdxDoc({ title: 'Impostor' }))

    await expect(syncPosts(testDb.db, { contentRoot: root })).rejects.toThrow(/Duplicate slugs/)
    const [row] = await allRows()
    expect(row).toMatchObject({ title: 'Original' })
  })

  it('takes a transaction-scoped advisory lock before reading existing rows', async () => {
    // PGlite is a single connection, so two writers cannot actually contend
    // here; pin the two properties the serialization relies on instead.
    const queries: string[] = []
    const db = drizzle(testDb.client, {
      schema,
      logger: {
        logQuery: (query) => {
          queries.push(query)
        },
      },
    })
    root = makeContentDir({
      'articles/alpha.mdx': mdxDoc(),
    })
    await syncPosts(db, { contentRoot: root })

    // 1. the lock is the transaction's first statement, before the slug read
    // (transaction control is dropped: whether the driver logs begin/commit
    // is a driver detail, not part of what is being pinned)
    const statements = queries.filter(query => !/^(?:begin|commit|rollback)\b/i.test(query))
    expect(statements[0]).toMatch(/^select pg_advisory_xact_lock\(\$1\)$/)
    expect(statements[1]).toMatch(/^select "slug" from "posts"/)
    // 2. commit releases it: nothing is left held on the session
    const { rows } = await testDb.client.query(`select count(*)::int as held from pg_locks where locktype = 'advisory'`)
    expect(rows).toEqual([
      { held: 0 },
    ])
  })
})
