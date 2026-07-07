-- Postgres has no implicit enum -> varchar assignment cast; the USING
-- clause is added by hand (drizzle-kit does not emit it).
ALTER TABLE "posts" ALTER COLUMN "category" SET DATA TYPE varchar(100) USING "category"::text;--> statement-breakpoint
DROP TYPE "public"."category_enum";
