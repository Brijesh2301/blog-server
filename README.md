# Devlume API

Express 5 + TypeScript + PostgreSQL (Drizzle ORM).

## Status

**Phase 2 complete.** Schema, auth, RBAC, validation, the redirect engine and
public read endpoints are implemented and verified against a live database.

## Requirements

- Node.js >= 20.9
- PostgreSQL 14+ (developed on 16.1)

## Setup

```bash
cp .env.example .env     # set DATABASE_URL, and the JWT secrets for production
npm install

# One-time database creation
psql -U postgres -c "CREATE ROLE devlume LOGIN PASSWORD 'devlume_local_dev'"
psql -U postgres -c "CREATE DATABASE devlume_dev OWNER devlume"

npm run db:migrate       # applies ./drizzle/*.sql
npm run db:seed          # 3 authors, 8 categories, 14 tags, 2 series, 15 posts
npm run dev
```

`GET /health/ready` should report `database: { ok: true }`.

The `citext`, `pg_trgm` and `unaccent` extensions are created by the first
migration, so the role needs rights to create extensions (superuser locally, or
have a DBA pre-create them in managed Postgres).

## Scripts

| Script                    | What it does                                |
| ------------------------- | ------------------------------------------- |
| `npm run dev`             | tsx watch on `src/index.ts`                 |
| `npm run build` / `start` | compile to `dist/`, run the compiled output |
| `npm run typecheck`       | `tsc --noEmit`, strict                      |
| `npm run lint`            | ESLint with type-aware rules                |
| `npm run db:generate`     | generate a migration from schema changes    |
| `npm run db:migrate`      | apply pending migrations                    |
| `npm run db:seed`         | idempotent seed data                        |
| `npm run db:studio`       | Drizzle Studio                              |

**Never run `db:push` against a deployed database.** It diffs the live schema
and can silently drop a column. Generate a migration, read the SQL, commit it.

## Layout

```
drizzle/            generated SQL migrations (committed, reviewed in diff)
src/
  config/env.ts     Zod-validated environment; refuses to boot in production
                    without JWT secrets
  db/
    schema.ts       14 tables, enums, indexes, relations
    index.ts        pooled connection + health check
    migrate.ts      migration runner (single connection, by design)
  lib/              jwt, password, tokens, slug, cookies
  middleware/       auth + RBAC, Zod validation, rate limits, error handler
  routes/           HTTP only — no business logic
  services/         auth, posts, redirects
  validators/       Zod schemas, shared limits with the editor
  scripts/seed.ts
```

## Schema notes

**Generated search vector.** `posts.search_vector` is a `tsvector` generated
column — title and focus keyword weighted `A`, subtitle and excerpt `B`, body
`C` — with a GIN index. Postgres maintains it, so it can never drift from the
row, and search needs no second datastore. Queries use
`websearch_to_tsquery`, which accepts human syntax and never throws on
malformed input.

**Redirects never cascade.** `redirects.post_id` is `ON DELETE SET NULL`, not
`CASCADE`. These rows exist to keep serving a URL after the post is gone;
cascading would delete the redirect at the exact moment it becomes necessary.

**Timestamps are `timestamptz` everywhere.** A publishing schedule that spans
time zones is unworkable with naive timestamps.

**`citext` for email** so uniqueness is case-insensitive at the storage layer
rather than depending on every caller remembering to lower-case first.

## Auth model

| Token   | Lifetime | Form                          | Storage                                                           |
| ------- | -------- | ----------------------------- | ----------------------------------------------------------------- |
| Access  | 15 min   | JWT (HS256, pinned algorithm) | httpOnly cookie, path `/`                                         |
| Refresh | 30 days  | opaque 48-byte random         | httpOnly cookie, path `/api/v1/auth`; SHA-256 in `refresh_tokens` |

Refresh tokens **rotate on every use**. A token is valid exactly once, so
replaying a rotated one means either theft or a race — and both are resolved by
revoking the user's entire token family. Tokens are never returned in a
response body.

`requireRole()` takes an explicit list rather than a numeric level, so adding a
role cannot silently widen access everywhere.

## Endpoints

```
GET    /health                    liveness (touches nothing)
GET    /health/ready              readiness (503 when the database is down)

POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
POST   /api/v1/auth/logout-all    revokes every session
GET    /api/v1/auth/me
GET    /api/v1/auth/sessions

GET    /api/v1/posts              filters: category, tag, author, series, q,
                                  featured, editorsPick, sort, page, limit
GET    /api/v1/posts/:slug
POST   /api/v1/posts              admin | editor | author
PATCH  /api/v1/posts/:id          admin | editor | owning author
DELETE /api/v1/posts/:id          admin | editor

GET    /api/v1/categories         GET /api/v1/categories/:slug
GET    /api/v1/tags               GET /api/v1/tags/:slug
GET    /api/v1/series             GET /api/v1/series/:slug
GET    /api/v1/authors

GET    /api/v1/redirects/resolve?path=/blog/old-slug
GET    /api/v1/redirects          admin | editor
POST   /api/v1/redirects          admin | editor
DELETE /api/v1/redirects?from=…   admin | editor
```

## Two bugs worth remembering

**`.partial()` does not strip `.default()`.** The update schema was derived
from the create schema with `.partial()`, and `status` carried
`.default('draft')`. Zod made the key optional but still applied the default,
so **every PATCH silently unpublished the post** — fixing a typo on a live
article would have taken it offline. The default now lives only in
`createPostSchema`. There is a regression test for this.

**`req.cookies` is typed `any`** by cookie-parser, which put unchecked values
straight into auth code. `lib/cookies.ts` narrows it once so the rest of the
codebase gets `string | undefined`.

## Phase 3 onward

Phase 3 consumes these endpoints from the Next.js frontend. Still to come:
comments and subscribers routes (tables exist), media upload, the admin
endpoints, scheduled publishing (`publishDueScheduled()` is written and
exported, needs a cron), and on-publish revalidation plus IndexNow pings.
