# ADR-0002: Committed migration history over schema push

- **Status**: Accepted (2026-07)
- **Repos affected**: tianwei-io-content (owns the schema), tianwei-io-api (reads the same table)

## Context

Production schema changes were applied with `drizzle-kit push` — a direct
diff between code and the live database, with no committed history. Two
latent problems:

1. The `category` column was a Postgres **enum whose values were computed
   at schema-build time by scanning `content/`'s subdirectories**. Adding
   a category folder without regenerating and pushing the schema made
   sync fail at the database level. The schema depended on checkout
   contents — non-deterministic by construction.
2. `content` and `is_published` were nullable in this repo's schema while
   the API and frontend contracts require them non-null. The three repos
   had silently drifted.

## Decision

- Replace `db:push` with a **committed, ordered migration chain**
  (`drizzle-kit generate` + `migrate`; `drizzle/migrations/` including
  `meta/` is version-controlled):
  - `0000` — idempotent baseline matching the introspected production
    DDL, so the first `migrate` against the live database records a no-op.
  - `0001` — `category` enum → `varchar(100)` (hand-added `USING` cast),
    matching the API repo's declaration exactly and removing the dynamic
    enum.
  - `0002` — backfill NULLs, then `SET NOT NULL` on `content` /
    `is_published`, converging the database on what the readers already
    assume.
  - `0003+` — additive, backward-compatible changes (e.g. `updated_at`).
- The schema file is fully static: no filesystem scanning, no environment
  dependence.
- Migration correctness is tested in CI: the chain is applied to an
  in-memory Postgres (PGlite) both from empty and from a simulated
  production shape with legacy NULL rows.

## Consequences

- Every schema state is reproducible from git history; rollback is
  "restore branch, run migrate on a Neon branch to rehearse".
- Contract evolution has a defined direction: the content engine migrates
  first (additively), readers adopt afterwards.
- New categories are now just data — no schema involvement at all.
