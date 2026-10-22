import { Router } from 'express'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '../db/index.js'
import { categories, posts, series, tags } from '../db/schema.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { badRequest, notFound } from '../middleware/error.js'
import { body, params, query, validate } from '../middleware/validate.js'
import { slugify, uniqueSlug } from '../lib/slug.js'
import { recordMove } from '../services/redirect.service.js'
import { slugParam, uuidParam } from '../validators/common.schema.js'

/**
 * Categories, tags, series and authors.
 *
 * Grouped in one router because they share a shape: a name, a unique slug that
 * becomes a URL, and per-page SEO overrides.
 */
export const taxonomyRouter: Router = Router()

/**
 * Tag pages below this threshold are served noindex.
 *
 * A tag with one or two posts is a near-duplicate of those posts with almost
 * no unique text, which is what Google classifies as thin content. Indexing
 * hundreds of them dilutes crawl budget for no gain.
 */
const THIN_TAG_THRESHOLD = 3

// ── Categories ──────────────────────────────────────────────────────────────

const categoryInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().max(140).optional(),
  description: z.string().trim().max(1000).optional(),
  introText: z.string().trim().max(5000).optional(),
  tone: z.string().trim().max(160).optional(),
  icon: z.string().trim().max(60).optional(),
  parentId: z.uuid().optional(),
  position: z.number().int().min(0).max(999).optional(),
  featured: z.boolean().optional(),
  metaTitle: z.string().trim().max(70).optional(),
  metaDescription: z.string().trim().max(200).optional(),
  ogImage: z.url().max(1000).optional(),
  noIndex: z.boolean().optional(),
})

taxonomyRouter.get('/categories', async (_req, res) => {
  const rows = await db
    .select()
    .from(categories)
    .orderBy(asc(categories.position), asc(categories.name))
  res.json({ categories: rows })
})

taxonomyRouter.get(
  '/categories/:slug',
  validate({ params: slugParam }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)
    const [category] = await db
      .select()
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1)
    if (!category) throw notFound('Category not found.')

    res.json({
      category: {
        ...category,
        // A category with no unique intro text is a bare list of links.
        // Phase 3 reads this flag to decide the robots directive.
        shouldIndex: !category.noIndex && Boolean(category.introText),
      },
    })
  }
)

taxonomyRouter.post(
  '/categories',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ body: categoryInput }),
  async (req, res) => {
    const input = body<z.infer<typeof categoryInput>>(req)
    const slug = await uniqueSlug(input.slug ?? slugify(input.name), async (c) => {
      const [row] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.slug, c))
        .limit(1)
      return Boolean(row)
    })

    const [created] = await db
      .insert(categories)
      .values({ ...input, slug })
      .returning()
    res.status(201).json({ category: created })
  }
)

// ── Tags ────────────────────────────────────────────────────────────────────

const tagInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  metaTitle: z.string().trim().max(70).optional(),
  metaDescription: z.string().trim().max(200).optional(),
})

taxonomyRouter.get('/tags', async (_req, res) => {
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      description: tags.description,
      postCount: tags.postCount,
      noIndex: tags.noIndex,
    })
    .from(tags)
    .orderBy(desc(tags.postCount), asc(tags.name))

  res.json({
    tags: rows.map((tag) => ({
      ...tag,
      shouldIndex: !tag.noIndex && tag.postCount >= THIN_TAG_THRESHOLD,
    })),
  })
})

taxonomyRouter.get('/tags/:slug', validate({ params: slugParam }), async (req, res) => {
  const { slug } = params<{ slug: string }>(req)
  const [tag] = await db.select().from(tags).where(eq(tags.slug, slug)).limit(1)
  if (!tag) throw notFound('Tag not found.')

  res.json({
    tag: {
      ...tag,
      shouldIndex: !tag.noIndex && tag.postCount >= THIN_TAG_THRESHOLD,
      thinThreshold: THIN_TAG_THRESHOLD,
    },
  })
})

taxonomyRouter.post(
  '/tags',
  requireAuth,
  requireRole('admin', 'editor', 'author'),
  validate({ body: tagInput }),
  async (req, res) => {
    const input = body<z.infer<typeof tagInput>>(req)
    const desired = slugify(input.slug ?? input.name)

    // Tags get created inline while writing, so a collision should reuse the
    // existing tag rather than mint a near-duplicate with a "-2" slug.
    const [existing] = await db.select().from(tags).where(eq(tags.slug, desired)).limit(1)
    if (existing) {
      res.status(200).json({ tag: existing, reused: true })
      return
    }

    const [created] = await db
      .insert(tags)
      .values({ ...input, slug: desired })
      .returning()
    res.status(201).json({ tag: created })
  }
)

// ── Series ──────────────────────────────────────────────────────────────────

taxonomyRouter.get('/series', async (_req, res) => {
  const rows = await db.select().from(series).orderBy(asc(series.title))
  res.json({ series: rows })
})

taxonomyRouter.get('/series/:slug', validate({ params: slugParam }), async (req, res) => {
  const { slug } = params<{ slug: string }>(req)
  const [row] = await db.select().from(series).where(eq(series.slug, slug)).limit(1)
  if (!row) throw notFound('Series not found.')

  const items = await db
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      excerpt: posts.excerpt,
      seriesPosition: posts.seriesPosition,
      readingMinutes: posts.readingMinutes,
      publishedAt: posts.publishedAt,
    })
    .from(posts)
    .where(eq(posts.seriesId, row.id))
    .orderBy(asc(posts.seriesPosition), asc(posts.publishedAt))

  res.json({ series: row, posts: items })
})

// ── Authors ─────────────────────────────────────────────────────────────────

/**
 * Only users with a slug, an authoring role and at least one published post.
 *
 * An author page with no posts is thin content, and a reader landing on one
 * from search finds nothing — so they are excluded from the listing and never
 * enter the sitemap.
 */
taxonomyRouter.get('/authors', async (_req, res) => {
  const rows = await db.execute(sql`
    SELECT u.id, u.name, u.slug, u.bio, u.job_title AS "jobTitle",
           u.credentials, u.avatar_url AS "avatarUrl", u.socials,
           u.knows_about AS "knowsAbout",
           count(p.id)::int AS "postCount"
    FROM users u
    LEFT JOIN posts p ON p.author_id = u.id AND p.status = 'published'
    WHERE u.slug IS NOT NULL AND u.role IN ('admin', 'editor', 'author')
    GROUP BY u.id
    HAVING count(p.id) > 0
    ORDER BY count(p.id) DESC, u.name ASC
  `)
  res.json({ authors: rows })
})

/* ═══════════════════════════════════════════════════════════════════════════
   TAXONOMY EDITING AND DELETION
   ═══════════════════════════════════════════════════════════════════════════
   Creation existed from Phase 2; editing and deletion did not, which meant a
   category typed wrong could never be corrected and a category created by
   mistake could never be removed except in psql.

   Deletion is the part that needs care, because a category slug is a PUBLIC
   URL. Removing one silently 404s a page that may have inbound links and
   rankings, so each delete below either refuses or records a redirect — the
   same machinery a post slug change already uses.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Only the keys an editor may change. `slug` is handled separately. */
const categoryPatch = categoryInput.partial()

taxonomyRouter.patch(
  '/categories/:id',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ params: uuidParam, body: categoryPatch }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    const input = body<z.infer<typeof categoryPatch>>(req)

    const [existing] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1)
    if (!existing) throw notFound('Category not found.')

    /*
     * A slug change moves a live URL, so it records a 301 exactly as a post
     * slug change does. Without this, renaming "backend" to "backend-infra"
     * silently 404s every link anyone ever made to the old listing.
     */
    let slug = existing.slug
    if (input.slug && input.slug !== existing.slug) {
      slug = await uniqueSlug(slugify(input.slug), async (candidate) => {
        const [row] = await db
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.slug, candidate))
          .limit(1)
        // Taken only if it belongs to a DIFFERENT category — otherwise an
        // edit that leaves the slug alone would collide with itself.
        return Boolean(row) && row!.id !== id
      })

      await recordMove({ from: `/category/${existing.slug}`, to: `/category/${slug}` })
    }

    const [updated] = await db
      .update(categories)
      .set({ ...input, slug })
      .where(eq(categories.id, id))
      .returning()

    res.json({ category: updated })
  }
)

const deleteQuery = z.object({
  /** Where posts in this category should go. Omit only if it is empty. */
  reassignTo: z.uuid().optional(),
})

/**
 * Deletes a category.
 *
 * REFUSES rather than cascading when posts still reference it. The schema has
 * `ON DELETE SET NULL`, so a blind delete would quietly leave published posts
 * with no category — which breaks their breadcrumbs, their JSON-LD
 * `articleSection`, and the publish checklist that requires one. An editor who
 * means it supplies `?reassignTo=<id>`.
 */
taxonomyRouter.delete(
  '/categories/:id',
  requireAuth,
  requireRole('admin'),
  validate({ params: uuidParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    const { reassignTo } = query<z.infer<typeof deleteQuery>>(req)

    const [existing] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1)
    if (!existing) throw notFound('Category not found.')

    const [counted] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(eq(posts.categoryId, id))
    const count = counted?.count ?? 0

    if (count > 0) {
      if (!reassignTo) {
        throw badRequest(
          `${count} post(s) still use this category. Pass reassignTo with another category id, or move them first.`
        )
      }
      if (reassignTo === id) {
        throw badRequest('Cannot reassign a category to itself.')
      }

      const [target] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.id, reassignTo))
        .limit(1)
      if (!target) throw badRequest('The category to reassign to does not exist.')

      await db
        .update(posts)
        .set({ categoryId: reassignTo })
        .where(eq(posts.categoryId, id))
    }

    await db.delete(categories).where(eq(categories.id, id))

    /*
     * The listing URL is now gone. A 410 tells Google the removal was
     * deliberate, which de-indexes it far faster than repeated 404s.
     *
     * `recordMove` expresses a 410 as a row whose `from` and `to` are the same
     * path — it is a "this is intentionally gone" marker rather than a
     * redirect, which is why the self-reference is correct here and refused
     * for every other status.
     */
    await recordMove({
      from: `/category/${existing.slug}`,
      to: `/category/${existing.slug}`,
      statusCode: 410,
      reason: 'delete',
    })

    res.status(204).end()
  }
)

// ── Tags ────────────────────────────────────────────────────────────────────

const tagPatch = tagInput.partial()

taxonomyRouter.patch(
  '/tags/:id',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ params: uuidParam, body: tagPatch }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    const input = body<z.infer<typeof tagPatch>>(req)

    const [existing] = await db.select().from(tags).where(eq(tags.id, id)).limit(1)
    if (!existing) throw notFound('Tag not found.')

    let slug = existing.slug
    if (input.slug && input.slug !== existing.slug) {
      slug = await uniqueSlug(slugify(input.slug), async (candidate) => {
        const [row] = await db
          .select({ id: tags.id })
          .from(tags)
          .where(eq(tags.slug, candidate))
          .limit(1)
        return Boolean(row) && row!.id !== id
      })
      await recordMove({ from: `/tag/${existing.slug}`, to: `/tag/${slug}` })
    }

    const [updated] = await db
      .update(tags)
      .set({ ...input, slug })
      .where(eq(tags.id, id))
      .returning()

    res.json({ tag: updated })
  }
)

/**
 * Deletes a tag.
 *
 * Unlike a category, this does NOT refuse when posts use it. `post_tags` is a
 * join table with `ON DELETE CASCADE`, so the associations go and the posts
 * themselves are untouched — a post with one fewer tag is still a complete,
 * publishable post. Tags are a browsing aid; a category is structural.
 */
taxonomyRouter.delete(
  '/tags/:id',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ params: uuidParam }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)

    const [existing] = await db.select().from(tags).where(eq(tags.id, id)).limit(1)
    if (!existing) throw notFound('Tag not found.')

    await db.delete(tags).where(eq(tags.id, id))
    await recordMove({
      from: `/tag/${existing.slug}`,
      to: `/tag/${existing.slug}`,
      statusCode: 410,
      reason: 'delete',
    })

    res.status(204).end()
  }
)
