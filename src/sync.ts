import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type * as schema from '../drizzle/schema.ts'
import type { SyncResult } from './types.ts'
import { getTableColumns, inArray, sql } from 'drizzle-orm'
import { posts } from '../drizzle/schema.ts'
import { CONTENT_ROOT } from './config.ts'
import { parseAllPosts } from './parser.ts'

/**
 * Any Postgres-flavoured Drizzle instance over our schema.
 * Satisfied by both node-postgres (production) and PGlite (tests).
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

/** Arbitrary but fixed pg_advisory_xact_lock key; every writer must use the same one. */
const SYNC_LOCK_KEY = 726_100_001

// On a slug conflict every other column takes the incoming value. Derived
// from the table, so a new column can never be inserted but left stale on
// update.
const { id: _id, slug: _slug, ...updatableColumns } = getTableColumns(posts)
const TAKE_INCOMING = Object.fromEntries(
  Object.entries(updatableColumns).map(([key, column]) => [
    key,
    sql.raw(`excluded."${column.name}"`),
  ]),
)

export interface SyncOptions {
  /** Directory to parse; defaults to the repo's /content */
  contentRoot?: string
  /**
   * Allow a sync that would delete every row (i.e. the content
   * directory parsed to zero records). Off by default so a bad
   * checkout or wrong path can never wipe the production table.
   */
  allowEmpty?: boolean
}

/**
 * Reconcile the posts table with the content directory, atomically.
 *
 * 1. Parse everything first: any invalid file aborts before the
 *    database is touched (parseAllPosts throws an aggregated error).
 * 2. In a single transaction: upsert every parsed record (keyed on
 *    slug, so ids of unchanged posts are stable) and delete rows whose
 *    slug no longer exists on disk (handles file renames/removals).
 *
 * Readers under READ COMMITTED observe either the previous state or
 * the new state, never an empty or partially-synced table.
 *
 * Writers are serialized: the transaction first takes an advisory lock,
 * so a second sync (a manual `sync:prod` during a deploy, or the local
 * watcher) waits and then diffs against the committed result. Without
 * it, two syncs starting from the same rows would each delete only the
 * stale slugs they saw and could commit a mix of both content sets.
 */
export async function syncPosts(db: Db, options: SyncOptions = {}): Promise<SyncResult> {
  const contentRoot = options.contentRoot ?? CONTENT_ROOT

  const records = parseAllPosts(contentRoot)

  if (records.length === 0 && !options.allowEmpty) {
    throw new Error(
      `[sync] Refusing to reconcile: no content found under "${contentRoot}". `
      + `This would delete every post. Pass allowEmpty (--allow-empty) if intentional.`,
    )
  }

  return db.transaction(async (tx) => {
    // Transaction-scoped, so commit or rollback always releases it (and it
    // works through Neon's transaction-mode pooler, unlike session locks).
    await tx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK_KEY})`)

    const existing = await tx.select({ slug: posts.slug }).from(posts)

    const diskSlugs = new Set(records.map(record => record.slug))
    const deletedSlugs = existing
      .map(row => row.slug)
      .filter(slug => !diskSlugs.has(slug))

    // Chunked to stay far below the Postgres wire-protocol limit of 65535
    // bind parameters per statement (9 params/row → hard ceiling ~7280 rows).
    const UPSERT_CHUNK_SIZE = 1000
    for (let offset = 0; offset < records.length; offset += UPSERT_CHUNK_SIZE) {
      await tx
        .insert(posts)
        .values(records.slice(offset, offset + UPSERT_CHUNK_SIZE))
        .onConflictDoUpdate({ target: posts.slug, set: TAKE_INCOMING })
    }

    if (deletedSlugs.length > 0)
      await tx.delete(posts).where(inArray(posts.slug, deletedSlugs))

    return {
      upserted: records.length,
      deleted: deletedSlugs.length,
      deletedSlugs,
    }
  })
}
