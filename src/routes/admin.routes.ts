import { Router } from 'express'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '../db/index.js'
import { categories, comments, posts, subscribers, users } from '../db/schema.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { body, validate } from '../middleware/validate.js'
import { scorePost } from '../services/seo-score.service.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ADMIN API
 * ═════════════════════════════════════════════════════════════════════════════
 * Everything here is behind `requireAuth` + a role check. Mounted under
 * /api/v1/admin so the whole prefix can be blocked in robots.txt and at the
 * proxy in one rule.
 */
export const adminRouter: Router = Router()

adminRouter.use(requireAuth, requireRole('admin', 'editor', 'author'))

// ─────────────────────────────────────────────────────────────────────────────
// Live SEO score — stateless
// ─────────────────────────────────────────────────────────────────────────────

const scoreInput = z.object({
  title: z.string().max(300).optional(),
  metaTitle: z.string().max(300).optional(),
  metaDescription: z.string().max(500).optional(),
  slug: z.string().max(300).optional(),
  excerpt: z.string().max(1000).optional(),
  focusKeyword: z.string().max(200).optional(),
  contentHtml: z.string().max(1_000_000).optional(),
  contentText: z.string().max(1_000_000).optional(),
  coverImageUrl: z.string().max(1000).optional(),
  coverImageAlt: z.string().max(500).optional(),
  categoryId: z.string().max(64).optional(),
  tagCount: z.number().int().min(0).max(50).optional(),
})

/**
 * Scores an UNSAVED draft.
 *
 * Stateless on purpose: the editor posts whatever is currently in the form, so
 * the panel updates as the writer types without autosaving half-finished work.
 * It is the same function the publish path enforces, so the panel can never
 * disagree with what the API will accept.
 */
adminRouter.post('/seo-score', validate({ body: scoreInput }), (req, res) => {
  res.json(scorePost(body<z.infer<typeof scoreInput>>(req)))
})

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counts for the dashboard.
 *
 * One round trip of parallel aggregates rather than a query per tile: the
 * dashboard is the first screen after login and should not take six sequential
 * round trips to paint.
 */
adminRouter.get('/stats', async (_req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [
    postCounts,
    totalViews,
    topPosts,
    recentPosts,
    subscriberCounts,
    pendingComments,
    categoryBreakdown,
    needsReview,
  ] = await Promise.all([
    db.select({ status: posts.status, n: count() }).from(posts).groupBy(posts.status),

    db
      .select({ views: sql<number>`coalesce(sum(${posts.viewCount}), 0)::int` })
      .from(posts)
      .where(eq(posts.status, 'published')),

    db
      .select({
        id: posts.id,
        slug: posts.slug,
        title: posts.title,
        viewCount: posts.viewCount,
        publishedAt: posts.publishedAt,
        seoScore: posts.seoScore,
      })
      .from(posts)
      .where(eq(posts.status, 'published'))
      .orderBy(desc(posts.viewCount))
      .limit(5),

    db
      .select({
        id: posts.id,
        slug: posts.slug,
        title: posts.title,
        status: posts.status,
        updatedAt: posts.updatedAt,
        seoScore: posts.seoScore,
      })
      .from(posts)
      .orderBy(desc(posts.updatedAt))
      .limit(8),

    db
      .select({ status: subscribers.status, n: count() })
      .from(subscribers)
      .groupBy(subscribers.status),

    db.select({ n: count() }).from(comments).where(eq(comments.status, 'pending')),

    db
      .select({ name: categories.name, slug: categories.slug, n: categories.postCount })
      .from(categories)
      .orderBy(desc(categories.postCount))
      .limit(8),

    // Content freshness: published more than a year ago and never re-reviewed.
    db
      .select({ n: count() })
      .from(posts)
      .where(
        and(
          eq(posts.status, 'published'),
          sql`${posts.reviewedAt} < now() - interval '1 year'`
        )
      ),
  ])

  const byStatus = Object.fromEntries(postCounts.map((row) => [row.status, row.n]))
  const bySubscriber = Object.fromEntries(
    subscriberCounts.map((row) => [row.status, row.n])
  )

  res.json({
    posts: {
      total: postCounts.reduce((sum, row) => sum + row.n, 0),
      published: byStatus.published ?? 0,
      draft: byStatus.draft ?? 0,
      scheduled: byStatus.scheduled ?? 0,
      inReview: byStatus.in_review ?? 0,
      staleCount: needsReview[0]?.n ?? 0,
    },
    views: { total: totalViews[0]?.views ?? 0, since: thirtyDaysAgo.toISOString() },
    subscribers: {
      total: subscriberCounts.reduce((sum, row) => sum + row.n, 0),
      confirmed: bySubscriber.confirmed ?? 0,
      pending: bySubscriber.pending ?? 0,
    },
    comments: { pending: pendingComments[0]?.n ?? 0 },
    topPosts,
    recentPosts,
    categories: categoryBreakdown,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Content health — the SEO problems worth fixing first
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Site-wide SEO issues, the ones that are cheap to detect in SQL and expensive
 * to find by hand: duplicate titles and descriptions, missing metadata, and
 * posts that have gone stale.
 */
adminRouter.get('/health', async (_req, res) => {
  const [duplicateTitles, duplicateDescriptions, missingMeta, stale, lowScore] =
    await Promise.all([
      db
        .select({ value: posts.metaTitle, n: count() })
        .from(posts)
        .where(and(eq(posts.status, 'published'), sql`${posts.metaTitle} IS NOT NULL`))
        .groupBy(posts.metaTitle)
        .having(sql`count(*) > 1`),

      db
        .select({ value: posts.metaDescription, n: count() })
        .from(posts)
        .where(
          and(eq(posts.status, 'published'), sql`${posts.metaDescription} IS NOT NULL`)
        )
        .groupBy(posts.metaDescription)
        .having(sql`count(*) > 1`),

      db
        .select({ id: posts.id, slug: posts.slug, title: posts.title })
        .from(posts)
        .where(
          and(
            eq(posts.status, 'published'),
            sql`(${posts.metaDescription} IS NULL OR ${posts.focusKeyword} IS NULL OR ${posts.coverImageAlt} IS NULL)`
          )
        )
        .limit(50),

      db
        .select({
          id: posts.id,
          slug: posts.slug,
          title: posts.title,
          reviewedAt: posts.reviewedAt,
        })
        .from(posts)
        .where(
          and(
            eq(posts.status, 'published'),
            sql`${posts.reviewedAt} < now() - interval '1 year'`
          )
        )
        .orderBy(posts.reviewedAt)
        .limit(50),

      db
        .select({
          id: posts.id,
          slug: posts.slug,
          title: posts.title,
          seoScore: posts.seoScore,
        })
        .from(posts)
        .where(and(eq(posts.status, 'published'), sql`${posts.seoScore} < 70`))
        .orderBy(posts.seoScore)
        .limit(50),
    ])

  res.json({
    duplicateTitles,
    duplicateDescriptions,
    missingMeta,
    stale,
    lowScore,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Users — admin only
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get('/users', requireRole('admin'), async (_req, res) => {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      slug: users.slug,
      role: users.role,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(200)

  res.json({ users: rows })
})

adminRouter.get('/subscribers', requireRole('admin', 'editor'), async (_req, res) => {
  const rows = await db
    .select({
      id: subscribers.id,
      email: subscribers.email,
      status: subscribers.status,
      source: subscribers.source,
      confirmedAt: subscribers.confirmedAt,
      createdAt: subscribers.createdAt,
    })
    .from(subscribers)
    .orderBy(desc(subscribers.createdAt))
    .limit(1000)

  res.json({ subscribers: rows })
})

/**
 * CSV export.
 *
 * Fields are quoted and internal quotes doubled, per RFC 4180. Without that a
 * comma or quote in a value shifts every subsequent column — and these files
 * get opened in spreadsheets where that corruption is silent.
 */
adminRouter.get('/subscribers.csv', requireRole('admin'), async (_req, res) => {
  const rows = await db
    .select({
      email: subscribers.email,
      status: subscribers.status,
      source: subscribers.source,
      confirmedAt: subscribers.confirmedAt,
      createdAt: subscribers.createdAt,
    })
    .from(subscribers)
    .where(eq(subscribers.status, 'confirmed'))
    .orderBy(desc(subscribers.createdAt))

  // Narrowly typed rather than `unknown`: stringifying an object would quietly
  // write "[object Object]" into the export.
  const escape = (value: string | Date | null): string => {
    const text = value instanceof Date ? value.toISOString() : (value ?? '')
    return `"${text.replace(/"/g, '""')}"`
  }

  const csv = [
    ['email', 'status', 'source', 'confirmed_at', 'created_at'].join(','),
    ...rows.map((row) =>
      [row.email, row.status, row.source, row.confirmedAt, row.createdAt]
        .map(escape)
        .join(',')
    ),
  ].join('\r\n')

  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', 'attachment; filename="devlume-subscribers.csv"')
  res.send(csv)
})

// ─────────────────────────────────────────────────────────────────────────────
// Admin post list — includes drafts
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get('/posts', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const valid = ['draft', 'in_review', 'scheduled', 'published', 'archived'] as const
  const filter = valid.find((value) => value === status)

  const rows = await db
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      status: posts.status,
      seoScore: posts.seoScore,
      wordCount: posts.wordCount,
      viewCount: posts.viewCount,
      publishedAt: posts.publishedAt,
      scheduledFor: posts.scheduledFor,
      updatedAt: posts.updatedAt,
      authorName: users.name,
      categoryName: categories.name,
    })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .leftJoin(categories, eq(posts.categoryId, categories.id))
    .where(filter ? eq(posts.status, filter) : undefined)
    .orderBy(desc(posts.updatedAt))
    .limit(200)

  res.json({ posts: rows })
})
