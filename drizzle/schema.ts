import {
  boolean,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'

export const SLUG_MAX_LENGTH = 200
export const CATEGORY_MAX_LENGTH = 100
export const AUTHOR_MAX_LENGTH = 100

/**
 * Posts table schema:
 * Stores metadata, body content, and publishing state for each .mdx entry.
 */
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: SLUG_MAX_LENGTH }).notNull().unique(),
  category: varchar('category', { length: CATEGORY_MAX_LENGTH }).notNull(),

  title: text('title').notNull(),
  description: text('description'),
  author: varchar('author', { length: AUTHOR_MAX_LENGTH }).notNull(),

  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),

  // optional last-updated date; null means "never updated since publish"
  updatedAt: timestamp('updated_at', { mode: 'date' }),

  // whether this entry should be visible to the frontend
  isPublished: boolean('is_published').notNull().default(false),

  content: text('content').notNull(),
})
