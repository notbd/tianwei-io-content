import type { posts } from '../drizzle/schema.ts'

/**
 * One parsed content file: exactly a `posts` row minus the serial id, so
 * the parser's output is what the sync writes, column for column.
 * Dates are midnight in CONTENT_TIME_ZONE stored as UTC instants (ADR-0003);
 * an absent optional field is null, as in the table.
 */
export type ContentRecord = Omit<typeof posts.$inferSelect, 'id'>

/** Result of a structure validation on a content file path. */
export type StructureResult
  = | { ok: true, category: string, slug: string }
    | { ok: false, reason: string }

/** Summary of a reconcile run against the database. */
export interface SyncResult {
  /** Number of records parsed from disk and upserted */
  upserted: number
  /** Number of stale rows removed from the database */
  deleted: number
  /** Slugs of the removed rows */
  deletedSlugs: string[]
}
