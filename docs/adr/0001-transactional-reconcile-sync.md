# ADR-0001: Transactional reconcile instead of clear-then-reinsert

- **Status**: Accepted (2026-07)
- **Repos affected**: tianwei-io-content (writer), tianwei-io-api (reader)

## Context

The original production sync deleted every row in `posts`, then re-inserted
posts one by one, with no transaction. Two consequences:

1. The live API could observe an **empty or partially-populated table**
   during every deploy — readers got whatever happened to be committed at
   that instant.
2. Serial ids were reissued on every deploy, and a mid-loop failure left
   the database in a permanently partial state.

The watcher had the same class of problem event-by-event: raw `fs.watch`
callbacks raced each other, and a file rename could leave the old slug's
row orphaned forever.

## Decision

All writes go through a single entry point, `src/sync.ts#syncPosts`:

- **Parse first, write second.** Every content file is parsed and
  validated before the database is touched; any invalid file aborts the
  run with the database unchanged. Duplicate slugs across categories are
  rejected pre-flight (slug is the contract's identity key).
- **One transaction, reconcile semantics.** Upsert all parsed records
  keyed on `slug` (ids of unchanged posts stay stable) and delete rows
  whose slug no longer exists on disk. Under READ COMMITTED, readers see
  either the previous state or the new state — never an intermediate one.
- **Empty-parse guard.** A run that would delete every post refuses to
  execute unless explicitly flagged (`--allow-empty`), so a bad checkout
  or wrong path can never wipe production.
- **The watcher collapses event bursts** into one debounced reconcile,
  serialized by a running/pending latch — overlapping writes are
  structurally impossible.

## Consequences

- Deploys are atomic from the reader's perspective; the frontend's cache
  warming never fetches a half-synced catalog.
- Renames, deletions and edits all reduce to "reconcile disk vs table" —
  there is no per-event mutation logic left to get wrong.
- A full reconcile on every change is O(total posts), which is trivially
  cheap at blog scale and stays acceptable for thousands of posts.
- Failure of any single file blocks the whole sync (deliberate: partial
  content states were judged worse than a delayed deploy).
