import { Router } from 'express'
import { asc, eq, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { categories, posts, series, tags, users } from '../db/schema.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * SLUG MANIFEST — GET /api/v1/slugs
 * ═════════════════════════════════════════════════════════════════════════════
 * Every public slug, by type, in one small response.
 *
 * Why it exists: the frontend proxy needs to know whether a content URL exists
 * BEFORE the page renders, because once rendering starts the HTTP status line
 * is already sent and a `notFound()` can no longer produce a 404. Asking the
 * API per request would add a round trip to every page view; fetching the whole
 * manifest once a minute costs one request per process per minute.
 *
 * Size: slugs only, no titles or bodies. At 10,000 posts this is roughly 400KB
 * uncompressed and far less over the wire — and the proxy caps what it keeps.
 *
 * Public on purpose: it lists only URLs that are already publicly reachable.
 */
export const manifestRouter: Router = Router()

/** Hard ceiling, so the response can never become unbounded. */
const MAX_PER_TYPE = 20_000

manifestRouter.get('/slugs', async (_req, res) => {
  const [postRows, categoryRows, tagRows, authorRows, seriesRows] = await Promise.all([
    db
      .select({ slug: posts.slug })
      .from(posts)
      .where(eq(posts.status, 'published'))
      .orderBy(asc(posts.slug))
      .limit(MAX_PER_TYPE),
    db.select({ slug: categories.slug }).from(categories).limit(MAX_PER_TYPE),
    db.select({ slug: tags.slug }).from(tags).limit(MAX_PER_TYPE),
    db
      .select({ slug: users.slug })
      .from(users)
      .where(sql`${users.slug} IS NOT NULL`)
      .limit(MAX_PER_TYPE),
    db.select({ slug: series.slug }).from(series).limit(MAX_PER_TYPE),
  ])

  // Same TTL as the proxy cache, so a newly published post becomes known
  // within a minute even if the proxy misses the on-publish invalidation.
  res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300')

  res.json({
    posts: postRows.map((r) => r.slug),
    categories: categoryRows.map((r) => r.slug),
    tags: tagRows.map((r) => r.slug),
    authors: authorRows.map((r) => r.slug).filter((s): s is string => Boolean(s)),
    series: seriesRows.map((r) => r.slug),
  })
})
