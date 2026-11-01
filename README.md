<!-- markdownlint-disable MD007 MD033 MD041 -->
<samp>
<h1>tianwei-io-content</h1>

[![CI](https://github.com/notbd/tianwei-io-content/actions/workflows/ci.yml/badge.svg)](https://github.com/notbd/tianwei-io-content/actions/workflows/ci.yml)
[![Deploy](https://github.com/notbd/tianwei-io-content/actions/workflows/deploy-content.yml/badge.svg?branch=main)](https://github.com/notbd/tianwei-io-content/actions/workflows/deploy-content.yml)

The content engine of my personal website [tianwei.io](https://tianwei.io).

<h2>Stack</h2>

- **Runtime**: [Node.js](https://nodejs.org) + [TypeScript](https://www.typescriptlang.org)
- **ORM**: [Drizzle ORM](https://orm.drizzle.team)
- **Database**: [PostgreSQL](https://www.postgresql.org)
- **Remote DB Host**: [Neon](https://neon.com)
- **Content Format**: [MDX](https://mdxjs.com) files with frontmatter
- **Testing**: [Vitest](https://vitest.dev) + [PGlite](https://pglite.dev) (in-memory Postgres)
- **Infrastructure**: [Docker](https://www.docker.com) Compose (local Postgres), [GitHub Actions](https://docs.github.com/en/actions) (CI + remote sync)

<h2>Site Architecture</h2>

The site is split into three repos, each deployed on its own:

- **[Frontend](https://github.com/notbd/tianwei.io)**: a Next.js app that renders every page as static HTML from data it fetches through the API.
- **[API Layer](https://github.com/notbd/tianwei-io-api)**: a read-only REST API on Cloudflare Workers that serves the published posts from Postgres.
- **[Content Engine](https://github.com/notbd/tianwei-io-content)** (this repo): the posts themselves, written in MDX, validated and synced into Postgres on Neon.

A post goes live in three steps:

1. A push to `main` in this repo syncs every post into Postgres in one transaction.
2. The same deploy calls the frontend's `/api/revalidate`.
3. The frontend expires its cached data and renders the pages again through the API.

The frontend's data cache is the only cache in the system (the API does not cache), so step 2 is the one place where new content takes effect. Three services is more than a personal site needs; I split it on purpose, to practice what only exists between services: API contracts, independent deploys and cache invalidation across repos ([tianwei.io ADR-0001](https://github.com/notbd/tianwei.io/blob/main/docs/adr/0001-three-tier-architecture.md)).

<h2>How It Works</h2>

This repo owns the posts, the database schema and every write; the API only reads. A sync (`src/sync.ts`) makes the `posts` table match the files in `content/`:

- **Validate first**: every file is parsed before the database is touched, and one invalid file stops the run. Frontmatter follows a strict schema (a misspelled key such as `updateAt` is an error, not ignored), and the MDX body must compile with the parser the frontend uses and contain no JavaScript, which the frontend refuses to run. Errors name the file and line.
- **One transaction**: posts are upserted by slug, so ids stay stable, and rows whose files are gone are deleted. Readers never see a half-synced table ([ADR-0001](./docs/adr/0001-transactional-reconcile-sync.md)).
- **Guard rails**: concurrent syncs wait on a Postgres advisory lock, and a sync that finds no posts is refused unless `--allow-empty` is passed, so a bad checkout cannot empty production.
- **Dates**: `createdAt` and `updatedAt` are calendar dates in `America/New_York`, stored as that day's midnight there, whatever the machine's time zone ([ADR-0003](./docs/adr/0003-content-time-zone.md)).
- **Migrations**: the schema is in `drizzle/`, and the migration history is committed and applied by the deploy, never generated on the fly ([ADR-0002](./docs/adr/0002-committed-migration-history.md)).

<h2>Writing a Post</h2>

```shell
pnpm new-post "My Post Title"          # creates content/articles/my-post-title.mdx
pnpm new-post "My Post Title" notes    # in another category
```

The folder name is the category and the filename is the slug. A new post starts as a draft, with frontmatter that already passes the parser:

| Key | Required | Value |
| --- | --- | --- |
| `title` | yes | The post title |
| `description` | no | One sentence for the post list, the feed and link previews |
| `createdAt` | yes | Publish date, `yyyy-MM-dd` |
| `updatedAt` | no | Last meaningful update, `yyyy-MM-dd`, not before `createdAt` |
| `author` | yes | Author name |
| `isPublished` | yes | `false` keeps the post off the site |

The body is Markdown plus components with string props, such as `<MdxImage src="<cloudinary-id>" width="1024" height="768" alt="..." />` for images hosted on Cloudinary. Open a pull request: CI parses every post, so a broken one fails there and not in production. Merging to `main` syncs it; it shows on the site once `isPublished` is `true`, and until then the frontend's draft preview can show it.

<h2>Layout</h2>

| Path | Purpose |
| --- | --- |
| `content/{category}/{slug}.mdx` | The posts |
| `src/` | Parsing and validation, the transactional sync, the file watcher, the deploy's calls to the frontend |
| `drizzle/` | Database schema and the committed migration history (`migrations/`) |
| `scripts/` | Thin CLI entry points behind the `pnpm` scripts |
| `tests/` | Unit tests, and integration tests (migrations, sync, watcher) on PGlite |

<h2>Local Run</h2>

Prerequisites: **Node.js 26** (see `.nvmrc`), **pnpm 10** and **Docker**.

```shell
git clone git@github.com:notbd/tianwei-io-content.git
cd tianwei-io-content
pnpm install
cp .env.example .env.local   # the local defaults work as-is

# Start Postgres in Docker (localhost:5431), sync every post, then re-sync on each change
pnpm dev:up

# Stop Postgres when you are done
pnpm dev:down
```

| Script | Purpose |
| --- | --- |
| `pnpm dev:up` / `dev:down` / `dev:reset` | Local Postgres lifecycle + sync + watch |
| `pnpm new-post "Title" [category]` | Scaffold a draft (`isPublished: false`, today's date in `America/New_York`) that already passes the parser |
| `pnpm content:sync` | One-shot local sync (no watcher) |
| `pnpm sync:prod` | Production sync (requires `DATABASE_URL`) |
| `pnpm db:generate` / `db:migrate` | Generate a migration from schema changes / apply pending migrations |
| `pnpm frontend:revalidate` | Revalidate the frontend (twice, a minute apart), then check that every page renders |
| `pnpm lint` / `typecheck` / `test` | Quality gates (same as CI) |

<h2>Configuration</h2>

| Variable | Purpose |
| --- | --- |
| `LOCAL_*` | The local Docker Postgres (user, password, database, ports); the defaults in `.env.example` work as-is |
| `DATABASE_URL` | When set, the scripts use this database instead of the local one; in the deploy it comes from the `PROD_REMOTE_DATABASE_URL` secret |
| `FRONTEND_URL`, `REVALIDATION_SECRET` | Where `pnpm frontend:revalidate` calls `/api/revalidate`, and its bearer token (must match the frontend's) |

`.env.example` explains each one; the deploy workflow reads them from repository secrets.

<h2>Quality Gates</h2>

```shell
pnpm lint
pnpm typecheck
pnpm test   # unit tests; migrations, sync and watcher on PGlite
```

CI (`.github/workflows/ci.yml`) runs these on every pull request.

<h2>Deploy</h2>

A push to `main` that touches content or sync code runs `.github/workflows/deploy-content.yml`:

1. Run lint, typecheck and tests again.
2. Stop if the files it deploys differ from the head of `main`: re-running an old deploy would roll content back, so revert instead.
3. Apply pending migrations (`drizzle-kit migrate`).
4. Sync every post to Neon in one transaction.
5. Revalidate the frontend, again a minute later (for any page that was rendering during the sync), then request every page in the sitemap and fail unless each answers 200.

Deploys run one at a time, so two syncs never interleave.

<h2>License</h2>

Source code is licensed under <a href='./LICENSE'>AGPLv3</a>.<br>
The content is licensed under <a href='https://creativecommons.org/licenses/by-nc-sa/4.0/'>CC BY-NC-SA 4.0</a>.
</samp>
