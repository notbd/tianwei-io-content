import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import slugify from '@sindresorhus/slugify'
import {
  boolean,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Resolve and scan the /content directory to discover valid categories.
 * Each subfolder under /content becomes an allowed enum value (e.g., "articles", "notes").
 */
const contentDir = path.resolve(process.cwd(), 'content')
const categoryDirs
  = fs.existsSync(contentDir)
    ? fs
        .readdirSync(contentDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => slugify(d.name))
    : []
const categoryValues = (categoryDirs.length > 0
  ? categoryDirs
  : ['uncategorized']) as [string, ...string[]]

/**
 * Log detected categories during development for visibility.
 * Skipped in production to keep logs clean.
 */
if (process.env.NODE_ENV !== 'production') {
  const source = categoryDirs.length > 0 ? 'content folder' : 'fallback default'
  console.info(`[drizzle/schema] Categories from ${source}:`, categoryValues)
}

/**
 * Enum derived from subdirectories inside /content.
 * Used to constrain post categories (e.g. 'articles', 'notes').
 */
export const categoryEnum = pgEnum('category_enum', categoryValues)

/**
 * Posts table schema:
 * Stores metadata, body content, and publishing state for each .mdx entry.
 */
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  category: categoryEnum('category').notNull(),

  title: text('title').notNull(),
  description: text('description'),
  author: varchar('author', { length: 100 }).notNull(),

  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),

  // whether this entry should be visible to the frontend
  isPublished: boolean('is_published').default(false),

  content: text('content'),
})
