# ADR-0004: The local database runs inside the Node process

- **Status**: Accepted (2026-11)
- **Repos affected**: tianwei-io-content (the database and its endpoint), tianwei-io-api (reads it; `src/db/connector.ts`)

## Context

Local development used Postgres in Docker, started by `pnpm dev:up`. Two
things were wrong with it:

1. **Its only reader could not read it.** The API talks to Neon through
   `@neondatabase/serverless`'s HTTP driver, which turns the host of
   `DATABASE_URL` into an HTTPS endpoint on Neon's domain. Pointed at
   `127.0.0.1` it built the address `https://api.0.0.1/sql` and every
   route answered 500. So running the site locally took Docker for the
   content engine and a Neon branch for the API, two databases that did
   not know about each other.
2. **Nothing short of a staged release ran the three repos together.**
   The release runbook was built around that Neon branch: create it,
   migrate it, sync it, point the API at it, build the frontend, check by
   hand.

The integration tests already ran on PGlite (Postgres compiled to
WebAssembly, in the Node process), built from the committed migrations.

## Decision

The local database is PGlite, in the process that needs it, and that
process serves it over the protocol the API's driver speaks.

- `openLocalDb()` (`src/localDb.ts`) builds an in-memory Postgres from
  the committed migration chain, the DDL production runs. `pnpm dev`,
  `pnpm rehearse` and the integration tests all use it.
- `serveNeonHttp()` serves it on `127.0.0.1` over Neon's HTTP protocol.
  The API's connector sends a `DATABASE_URL` whose host is `127.0.0.1`
  or `localhost` to that endpoint over plain HTTP and leaves every other
  host to the driver. The API's queries, driver and Workers runtime are
  the production ones; only the far end of the HTTP request differs.
- The database is rebuilt from the files in `content/` on every start.
  The files are the source of truth, so there is nothing to keep.
- Docker, `docker-compose.yml`, the `LOCAL_*` variables and the eight
  scripts around them are gone. `DATABASE_URL` now always means a remote
  database, and only `pnpm sync:prod` and `pnpm db:migrate` connect to it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep Docker Postgres, add `pglite-socket` or a TCP proxy | The API still cannot read it: its driver speaks HTTP, not the Postgres wire protocol. One more dependency for nothing |
| Neon's `local-neon-http-proxy` in front of Docker Postgres | Speaks the right protocol, but keeps Docker as a prerequisite and adds a second container |
| Move the API to Hyperdrive and `pg` | Changes the production driver to make local development easier; the tail wagging the dog |
| Run the API under Node locally instead of `wrangler dev` | Loses workerd, the runtime production uses, and adds an adapter dependency |

## What the endpoint implements

Only what the API uses, and it refuses the rest instead of guessing
(the list is the doc comment of `serveNeonHttp`, and
`tests/integration/local-db.test.ts` holds it to it):

- `POST /sql`, one query per request, with the driver's
  `Neon-Connection-String` header and a loopback `Host`. A batch or a
  transaction is a 400.
- Parameters in as text, values out as the text Postgres produced, for
  the five column types the `posts` table has (`int4`, `varchar`, `text`,
  `timestamp`, `bool`). A result with any other type is a 400 that names
  the column.

It listens on `127.0.0.1` only. A web page cannot send it SQL: the
required header forces a preflight, which goes unanswered. Any process
on the machine can read and write it; it holds no credentials and has no
route to production.

## Consequences

- One command, `pnpm dev`, and no prerequisite but Node. The whole site
  runs locally in three terminals (README, Local Run).
- A release can be rehearsed on one machine: `pnpm rehearse` starts the
  three checkouts and plays the deploy's own steps against them.
- **Lost: a database that outlives the process.** There is no local
  state to inspect after `pnpm dev` ends. Use `psql` against a Neon
  branch when that is needed.
- **Lost: the `pg` driver path locally.** `pnpm sync:prod` and
  `pnpm db:migrate` connect with `pg` over TLS, and nothing local
  exercises that any more. It runs against a real database once before a
  release that changes the sync, the schema or the API (the frontend
  repo's `docs/release-verification.md`, the comparison with production),
  and on every deploy.
- PGlite is not Neon: same Postgres semantics for this schema, but a
  different build and version. The migrations test and the rehearsal
  catch a migration PGlite refuses; one that only Neon refuses is caught
  by the deploy, before the sync.

## When the endpoint needs more

- A new column type: add it to `SERVED_TYPES` in `src/localDb.ts` and a
  row to the endpoint's test. Until then the API's read fails locally
  with a message that names the column and its type.
- The API starts using a transaction or a batch: implement `{ queries }`
  in the endpoint, with a test, in the same change.
