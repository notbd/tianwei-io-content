/**
 * Represents the unified content record used across the
 * parsing, synchronization, and database layers.
 */
export interface ContentRecord {
  /** Unique slug (derived from filename) */
  slug: string

  /** The content category (derived from subfolder name) */
  category: string

  /** The visible title of the post */
  title: string

  /** Optional summary or meta description */
  description?: string

  /** Author name */
  author: string

  /** Publication date: midnight in CONTENT_TIME_ZONE, stored as a UTC instant (ADR-0003) */
  createdAt: Date

  /** Optional last-updated date: same encoding as createdAt, never before it */
  updatedAt?: Date

  /** Whether this record is visible on the frontend */
  isPublished: boolean

  /** Raw Markdown/MDX string content */
  content: string
}

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
