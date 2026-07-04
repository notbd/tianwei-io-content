import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The DDL that exists in production today (from drizzle-kit pull),
// used to prove the migration chain upgrades a live database in place.
const PROD_DDL = `
CREATE TYPE "public"."category_enum" AS ENUM('articles');
CREATE TABLE "posts" (
  "id" serial PRIMARY KEY NOT NULL,
  "slug" varchar(200) NOT NULL,
  "category" "category_enum" NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "author" varchar(100) NOT NULL,
  "created_at" timestamp NOT NULL,
  "is_published" boolean DEFAULT false,
  "content" text,
  CONSTRAINT "posts_slug_unique" UNIQUE("slug")
);
`

let client: PGlite

beforeEach(() => {
  client = new PGlite()
})

afterEach(async () => {
  await client.close()
})

async function runMigrations() {
  const db = drizzle(client)
  await migrate(db, { migrationsFolder: 'drizzle/migrations' })
  return db
}

async function columnInfo() {
  const result = await client.query<{
    column_name: string
    data_type: string
    is_nullable: string
    character_maximum_length: number | null
    column_default: string | null
  }>(
    `SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
     FROM information_schema.columns
     WHERE table_name = 'posts'`,
  )
  return new Map(result.rows.map(row => [row.column_name, row]))
}

describe('migration chain', () => {
  it('builds the final schema from an empty database', async () => {
    await runMigrations()
    const columns = await columnInfo()

    expect(columns.get('category')).toMatchObject({
      data_type: 'character varying',
      character_maximum_length: 100,
      is_nullable: 'NO',
    })
    expect(columns.get('is_published')).toMatchObject({
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false',
    })
    expect(columns.get('content')).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    })
    expect(columns.get('updated_at')).toMatchObject({
      data_type: 'timestamp without time zone',
      is_nullable: 'YES',
    })
    expect(columns.get('slug')).toMatchObject({
      data_type: 'character varying',
      character_maximum_length: 200,
      is_nullable: 'NO',
    })

    // the enum type must be gone
    const enums = await client.query(
      `SELECT typname FROM pg_type WHERE typname = 'category_enum'`,
    )
    expect(enums.rows).toHaveLength(0)
  })

  it('upgrades the current production shape in place, backfilling NULLs', async () => {
    // simulate production: old DDL + a legacy row with NULL content
    await client.exec(PROD_DDL)
    await client.exec(`
      INSERT INTO posts (slug, category, title, author, created_at, is_published, content)
      VALUES ('legacy-post', 'articles', 'Legacy', 'Tianwei Zhang', '2024-01-01', NULL, NULL);
    `)

    await runMigrations()

    const columns = await columnInfo()
    expect(columns.get('category')?.data_type).toBe('character varying')
    expect(columns.get('content')?.is_nullable).toBe('NO')

    const rows = await client.query<{ category: string, content: string, is_published: boolean }>(
      `SELECT category, content, is_published FROM posts WHERE slug = 'legacy-post'`,
    )
    expect(rows.rows[0]).toEqual({
      category: 'articles', // enum value preserved as text
      content: '', // NULL backfilled
      is_published: false, // NULL backfilled
    })
  })

  it('records all migrations in the journal exactly once', async () => {
    await runMigrations()
    const journal = await client.query<{ count: string }>(
      `SELECT count(*) FROM drizzle.__drizzle_migrations`,
    )
    expect(Number(journal.rows[0]?.count)).toBe(4)

    // a second migrate() run is a no-op
    await runMigrations()
    const again = await client.query<{ count: string }>(
      `SELECT count(*) FROM drizzle.__drizzle_migrations`,
    )
    expect(Number(again.rows[0]?.count)).toBe(4)
  })
})
