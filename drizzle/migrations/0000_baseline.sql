-- Baseline: the schema shape that already exists in production.
-- Hand-edited to be idempotent so the first `drizzle-kit migrate` run
-- against the live (already-populated) database records this as a no-op.
DO $$ BEGIN
	CREATE TYPE "public"."category_enum" AS ENUM('articles');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "posts" (
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
