-- Backfill legacy NULLs before tightening constraints; same file, so the
-- migrator runs everything in one transaction.
UPDATE "posts" SET "is_published" = false WHERE "is_published" IS NULL;--> statement-breakpoint
UPDATE "posts" SET "content" = '' WHERE "content" IS NULL;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "is_published" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "content" SET NOT NULL;
