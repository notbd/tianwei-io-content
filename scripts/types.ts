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

  /** Author name (required; may be defaulted upstream) */
  author: string

  /** Published creation date */
  createdAt: Date

  /** Whether this record is visible on the frontend */
  isPublished: boolean

  /** Raw Markdown/MDX string content */
  content: string
}
