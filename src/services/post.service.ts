import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'

import { db } from '../db/index.js'
import { categories, postTags, posts, series, tags, users } from '../db/schema.js'
import { postPath, slugify, uniqueSlug } from '../lib/slug.js'
import { badRequest, conflict, notFound } from '../middleware/error.js'
import type {
  CreatePostInput,
  ListPostsQuery,
  UpdatePostInput,
} from '../validators/post.schema.js'
import { onPostDeleted, onPostMoved, onPostPublished } from './publish.service.js'
import { recordMove } from './redirect.service.js'
import { scorePost } from './seo-score.service.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * POST SERVICE
 * ═════════════════════════════════════════════════════════════════════════════
 * Two behaviours here carry the Phase 2 SEO gate:
 *
 *  1. Slug uniqueness is guaranteed by `uniqueSlug` AND by the unique index on
 *     `posts.slug`. The index is the real guarantee — two concurrent creates
 *     can both pass the lookup, and the database is what actually prevents the
 *     duplicate URL.
 *
 *  2. Changing the slug of a PUBLISHED post automatically records a 301 from
 *     the old path. Draft slug changes do not, because a draft URL was never
 *     public and a redirect from it would be noise.
 */

/** Average adult reading speed. Matches the client's `readingTime()`. */
const WORDS_PER_MINUTE = 225

function deriveMetrics(contentText: string | undefined | null) {
  const words = (contentText ?? '').trim().split(/\s+/).filter(Boolean).length
  return {
    wordCount: words,
    readingMinutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
  }
}

/**
 * Blocks a publish that fails the editorial checklist.
 *
 * Enforced HERE rather than only in the editor UI, because a direct API call
 * would otherwise bypass it entirely. The Zod schema covers the fields that
 * must be present; this covers the ones that depend on the rendered body —
 * heading structure, image alt text, a second H1 — which a schema cannot see.
 */
function assertPublishable(input: Parameters<typeof scorePost>[0]): void {
  const report = scorePost(input)
  if (report.blockers.length === 0) return

  throw badRequest('This post is not ready to publish.', {
    score: report.score,
    blockers: report.blockers.map((check) => ({
      id: check.id,
      label: check.label,
      hint: check.hint,
    })),
  })
}

async function slugIsTaken(candidate: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.slug, candidate))
    .limit(1)
  if (!row) return false
  return exceptId ? row.id !== exceptId : true
}

/** Columns returned to public callers. Excludes the heavy TipTap document. */
const listColumns = {
  id: posts.id,
  slug: posts.slug,
  title: posts.title,
  subtitle: posts.subtitle,
  excerpt: posts.excerpt,
  coverImageUrl: posts.coverImageUrl,
  coverImageAlt: posts.coverImageAlt,
  status: posts.status,
  featured: posts.featured,
  editorsPick: posts.editorsPick,
  readingMinutes: posts.readingMinutes,
  wordCount: posts.wordCount,
  viewCount: posts.viewCount,
  likeCount: posts.likeCount,
  commentCount: posts.commentCount,
  publishedAt: posts.publishedAt,
  updatedAt: posts.updatedAt,
  audioStatus: posts.audioStatus,
  audioDuration: posts.audioDuration,
  locale: posts.locale,
  translationOfId: posts.translationOfId,
  author: {
    id: users.id,
    name: users.name,
    slug: users.slug,
    avatarUrl: users.avatarUrl,
    jobTitle: users.jobTitle,
  },
  category: {
    id: categories.id,
    name: categories.name,
    slug: categories.slug,
    tone: categories.tone,
  },
}

export async function listPosts(q: ListPostsQuery) {
  const conditions: SQL[] = []

  // Public callers never see drafts. An explicit status is honoured only on
  // admin routes, which pass it after their own role check.
  conditions.push(eq(posts.status, q.status ?? 'published'))

  /*
   * Language is a HARD filter, not a preference.
   *
   * Mixing languages in one listing is the single most confusing thing a
   * multilingual site can do: a reader on /hi/blog sees English cards they
   * cannot read, and Google sees a page whose content contradicts its own
   * `lang` and `hreflang`. Omitting the filter entirely — which is what
   * happened before this — meant the Hindi blog was just the English blog at
   * a different URL.
   */
  if (q.locale) conditions.push(eq(posts.locale, q.locale))

  if (q.category) conditions.push(eq(categories.slug, q.category))
  if (q.author) conditions.push(eq(users.slug, q.author))
  if (q.series) conditions.push(eq(series.slug, q.series))
  if (q.featured !== undefined) conditions.push(eq(posts.featured, q.featured))
  if (q.editorsPick !== undefined) conditions.push(eq(posts.editorsPick, q.editorsPick))

  // Full-text search against the generated, weighted tsvector column.
  // websearch_to_tsquery accepts human syntax ("quoted phrases", -exclusions)
  // and, unlike to_tsquery, never throws on malformed input.
  if (q.q) {
    conditions.push(sql`${posts.searchVector} @@ websearch_to_tsquery('english', ${q.q})`)
  }

  if (q.tag) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${postTags}
        JOIN ${tags} ON ${tags.id} = ${postTags.tagId}
        WHERE ${postTags.postId} = ${posts.id} AND ${tags.slug} = ${q.tag}
      )`
    )
  }

  const where = and(...conditions)

  const orderBy = (() => {
    switch (q.sort) {
      case 'oldest':
        return [asc(posts.publishedAt)]
      case 'popular':
        return [desc(posts.viewCount), desc(posts.publishedAt)]
      case 'relevance':
        return q.q
          ? [
              desc(
                sql`ts_rank(${posts.searchVector}, websearch_to_tsquery('english', ${q.q}))`
              ),
              desc(posts.publishedAt),
            ]
          : [desc(posts.publishedAt)]
      default:
        return [desc(posts.publishedAt)]
    }
  })()

  const rows = await db
    .select(listColumns)
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .leftJoin(categories, eq(posts.categoryId, categories.id))
    .leftJoin(series, eq(posts.seriesId, series.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(q.limit)
    .offset((q.page - 1) * q.limit)

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .leftJoin(categories, eq(posts.categoryId, categories.id))
    .leftJoin(series, eq(posts.seriesId, series.id))
    .where(where)

  return { rows, total: countRow?.total ?? 0 }
}

export async function getPostBySlug(
  slug: string,
  includeDrafts = false,
  locale?: string
) {
  /*
   * A slug is unique PER LOCALE, so resolving one without the locale is
   * ambiguous the moment a translation exists — it would return whichever row
   * Postgres happened to reach first, which is how a Hindi URL ends up
   * serving the English article.
   */
  const conditions = [eq(posts.slug, slug)]
  if (locale) conditions.push(eq(posts.locale, locale))
  if (!includeDrafts) conditions.push(eq(posts.status, 'published'))

  const [post] = await db
    .select({
      ...listColumns,
      content: posts.content,
      contentHtml: posts.contentHtml,
      contentText: posts.contentText,
      metaTitle: posts.metaTitle,
      metaDescription: posts.metaDescription,
      canonicalUrl: posts.canonicalUrl,
      ogImage: posts.ogImage,
      focusKeyword: posts.focusKeyword,
      secondaryKeywords: posts.secondaryKeywords,
      noIndex: posts.noIndex,
      faq: posts.faq,
      audioUrl: posts.audioUrl,
      audioVoice: posts.audioVoice,
      audioEnabled: posts.audioEnabled,
      // Needed by the editor, which otherwise cannot show the current state of
      // the toggle it is about to write.
      allowComments: posts.allowComments,
      locale: posts.locale,
      translationOfId: posts.translationOfId,
      seriesId: posts.seriesId,
      seriesPosition: posts.seriesPosition,
      reviewedAt: posts.reviewedAt,
      createdAt: posts.createdAt,
      authorBio: users.bio,
      authorCredentials: users.credentials,
      authorSocials: users.socials,
    })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .leftJoin(categories, eq(posts.categoryId, categories.id))
    .where(and(...conditions))
    .limit(1)

  if (!post) return null

  const postTagRows = await db
    .select({ id: tags.id, name: tags.name, slug: tags.slug })
    .from(postTags)
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(eq(postTags.postId, post.id))

  return { ...post, tags: postTagRows }
}

export async function createPost(input: CreatePostInput, authorId: string) {
  const slug = input.slug
    ? await (async () => {
        if (await slugIsTaken(input.slug!)) {
          throw conflict(`The slug "${input.slug}" is already in use.`)
        }
        return input.slug!
      })()
    : await uniqueSlug(slugify(input.title), (c) => slugIsTaken(c))

  const metrics = deriveMetrics(input.contentText)

  if (input.status === 'published' || input.status === 'scheduled') {
    assertPublishable({ ...input, tagCount: input.tagIds?.length ?? 0 })
  }

  const [created] = await db
    .insert(posts)
    .values({
      ...stripRelationFields(input),
      slug,
      authorId,
      ...metrics,
      seoScore: scorePost({ ...input, tagCount: input.tagIds?.length ?? 0 }).score,
      publishedAt:
        input.status === 'published'
          ? input.publishedAt
            ? new Date(input.publishedAt)
            : new Date()
          : input.publishedAt
            ? new Date(input.publishedAt)
            : null,
      scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
    })
    .returning()

  if (!created) throw new Error('Failed to create post.')

  if (input.tagIds?.length) await syncTags(created.id, input.tagIds)
  await refreshCounts(created.categoryId, input.tagIds)

  // Fire and forget: a failed cache purge must not fail the publish.
  if (created.status === 'published') {
    onPostPublished(created.slug, await categorySlugFor(created.categoryId))
  }

  return created
}

export async function updatePost(id: string, input: UpdatePostInput) {
  const [existing] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  if (!existing) throw notFound('Post not found.')

  let slug = existing.slug
  if (input.slug && input.slug !== existing.slug) {
    if (await slugIsTaken(input.slug, id)) {
      throw conflict(`The slug "${input.slug}" is already in use.`)
    }
    slug = input.slug
  }

  const contentText = input.contentText ?? existing.contentText
  const metrics = deriveMetrics(contentText)

  const becomingPublished =
    input.status === 'published' && existing.status !== 'published'

  // Validate the merged result, not the patch: a PATCH that only flips status
  // to published must still be checked against the post's existing body.
  if (input.status === 'published' || input.status === 'scheduled') {
    assertPublishable({
      title: input.title ?? existing.title,
      metaTitle: input.metaTitle ?? existing.metaTitle,
      metaDescription: input.metaDescription ?? existing.metaDescription,
      slug,
      excerpt: input.excerpt ?? existing.excerpt,
      focusKeyword: input.focusKeyword ?? existing.focusKeyword,
      contentHtml: input.contentHtml ?? existing.contentHtml,
      contentText,
      coverImageUrl: input.coverImageUrl ?? existing.coverImageUrl,
      coverImageAlt: input.coverImageAlt ?? existing.coverImageAlt,
      categoryId: input.categoryId ?? existing.categoryId,
      tagCount: input.tagIds?.length,
    })
  }

  const [updated] = await db
    .update(posts)
    .set({
      ...stripRelationFields(input),
      slug,
      ...metrics,
      updatedAt: new Date(),
      publishedAt: becomingPublished
        ? input.publishedAt
          ? new Date(input.publishedAt)
          : new Date()
        : input.publishedAt
          ? new Date(input.publishedAt)
          : existing.publishedAt,
      scheduledFor: input.scheduledFor
        ? new Date(input.scheduledFor)
        : existing.scheduledFor,
    })
    .where(eq(posts.id, id))
    .returning()

  if (!updated) throw notFound('Post not found.')

  // The SEO gate: a published post that changes URL leaves a 301 behind.
  // Drafts are skipped — their URL was never public, so a redirect from it
  // would be noise in the table and a wasted lookup on every 404.
  if (slug !== existing.slug && existing.status === 'published') {
    await recordMove({
      from: postPath(existing.slug),
      to: postPath(slug),
      reason: 'slug_change',
      postId: id,
    })
  }

  if (input.tagIds) await syncTags(id, input.tagIds)
  await refreshCounts(updated.categoryId ?? existing.categoryId, input.tagIds)

  if (slug !== existing.slug && existing.status === 'published') {
    onPostMoved(existing.slug, slug)
  } else if (updated.status === 'published') {
    onPostPublished(updated.slug, await categorySlugFor(updated.categoryId))
  }

  return updated
}

export async function deletePost(id: string): Promise<void> {
  const [existing] = await db
    .select({ slug: posts.slug, status: posts.status, categoryId: posts.categoryId })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1)

  if (!existing) throw notFound('Post not found.')

  // A published URL that disappears should return 410 Gone, not 404: 410 tells
  // Google the removal is intentional and drops it from the index faster.
  if (existing.status === 'published') {
    await recordMove({
      from: postPath(existing.slug),
      to: postPath(existing.slug),
      statusCode: 410,
      reason: 'delete',
    })
  }

  await db.delete(posts).where(eq(posts.id, id))
  await refreshCounts(existing.categoryId, undefined)

  if (existing.status === 'published') onPostDeleted(existing.slug)
}

/** Resolves a category id to its slug, for targeted cache invalidation. */
async function categorySlugFor(categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null
  const [row] = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1)
  return row?.slug ?? null
}

/** Replaces a post's tag set in one transaction. */
async function syncTags(postId: string, tagIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(postTags).where(eq(postTags.postId, postId))
    if (tagIds.length) {
      await tx
        .insert(postTags)
        .values(tagIds.map((tagId) => ({ postId, tagId })))
        .onConflictDoNothing()
    }
  })
}

/**
 * Recomputes denormalised published-post counts.
 *
 * Recomputed rather than incremented: a counter that drifts (a failed
 * transaction, a direct SQL fix) stays wrong forever, and these drive the
 * thin-tag noindex rule, so being wrong has SEO consequences.
 */
async function refreshCounts(
  categoryId: string | null | undefined,
  tagIds: string[] | undefined
): Promise<void> {
  if (categoryId) {
    await db
      .update(categories)
      .set({
        postCount: sql`(
          SELECT count(*)::int FROM ${posts}
          WHERE ${posts.categoryId} = ${categoryId} AND ${posts.status} = 'published'
        )`,
      })
      .where(eq(categories.id, categoryId))
  }

  if (tagIds?.length) {
    await db
      .update(tags)
      .set({
        postCount: sql`(
          SELECT count(*)::int FROM ${postTags}
          JOIN ${posts} ON ${posts.id} = ${postTags.postId}
          WHERE ${postTags.tagId} = ${tags.id} AND ${posts.status} = 'published'
        )`,
      })
      .where(inArray(tags.id, tagIds))
  }
}

/** Removes fields that live in other tables before an insert/update. */
function stripRelationFields<T extends { tagIds?: unknown }>(input: T) {
  const { tagIds: _tagIds, ...rest } = input
  return rest
}

/**
 * Publishes posts whose scheduled time has passed.
 * Phase 4 calls this from a cron; exported now so scheduling is testable.
 */
export async function publishDueScheduled(): Promise<string[]> {
  const due = await db
    .update(posts)
    .set({
      status: 'published',
      publishedAt: sql`COALESCE(${posts.scheduledFor}, now())`,
    })
    .where(and(eq(posts.status, 'scheduled'), sql`${posts.scheduledFor} <= now()`))
    .returning({ slug: posts.slug })

  return due.map((row) => row.slug)
}

/**
 * Related posts.
 *
 * The brief asks for a blend of tags, category and popularity rather than a
 * plain "same category" list, because category adjacency alone surfaces the
 * newest sibling rather than the most relevant one.
 *
 * Scored in ONE query so there is no N+1 and no in-memory merge of three
 * result sets:
 *
 *   shared tags   x3  — the strongest topical signal we have
 *   same category x2  — broad subject agreement
 *   same series   x4  — explicitly sequential content; nothing is more related
 *   popularity    tiebreak only, log-scaled so one viral post cannot crowd out
 *                 every genuinely relevant article
 *
 * Internal linking is an SEO feature, not a UI nicety: these links are the
 * crawl paths between articles, so a post with no category and no tags still
 * gets the recent-posts fallback rather than an empty section that strands it.
 */
export async function getRelatedPosts(slug: string, limit = 3) {
  const [post] = await db
    .select({
      id: posts.id,
      categoryId: posts.categoryId,
      seriesId: posts.seriesId,
    })
    .from(posts)
    .where(and(eq(posts.slug, slug), eq(posts.status, 'published')))
    .limit(1)

  if (!post) throw notFound('Post not found.')

  /*
   * Every parameter is CAST explicitly.
   *
   * Postgres cannot infer the type of a bare placeholder in a context like
   * `IS NOT DISTINCT FROM $1`, and the query fails outright with "could not
   * determine data type of parameter". A `::uuid` cast removes the ambiguity.
   */
  const sharedTags = sql<number>`(
    SELECT count(*)::int
    FROM ${postTags} AS mine
    JOIN ${postTags} AS theirs ON theirs.tag_id = mine.tag_id
    WHERE mine.post_id = ${post.id}::uuid AND theirs.post_id = ${posts.id}
  )`

  /*
   * The category and series terms are decided HERE, in TypeScript, rather than
   * with a `CASE WHEN ... IS NOT NULL` inside the query. We already know
   * whether this post has a category; asking the database to re-derive it from
   * a parameter it cannot type is both slower and more fragile.
   */
  const sameCategory = post.categoryId
    ? sql`CASE WHEN ${posts.categoryId} = ${post.categoryId}::uuid THEN 2 ELSE 0 END`
    : sql`0`

  const sameSeries = post.seriesId
    ? sql`CASE WHEN ${posts.seriesId} = ${post.seriesId}::uuid THEN 4 ELSE 0 END`
    : sql`0`

  const score = sql<number>`(
    ${sharedTags} * 3
    + ${sameCategory}
    + ${sameSeries}
    + ln(1 + ${posts.viewCount}) / 10
  )`

  const rows = await db
    .select({ ...listColumns, score })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .leftJoin(categories, eq(posts.categoryId, categories.id))
    .leftJoin(series, eq(posts.seriesId, series.id))
    .where(and(eq(posts.status, 'published'), ne(posts.id, post.id)))
    .orderBy(desc(score), desc(posts.publishedAt))
    .limit(limit)

  // `score` is an implementation detail of the ranking, not part of the card
  // contract; drop it so the response shape matches every other listing.
  return rows.map(({ score: _score, ...card }) => card)
}

/**
 * Every language a post exists in, including itself.
 *
 * Translations form a STAR around the original rather than a chain: every
 * translation points at the original, never at another translation. So the
 * whole set is `id = root OR translation_of_id = root`, in one query, with no
 * recursion and no risk of a cycle.
 *
 * The frontend uses this for two things: the hreflang pairs on an article,
 * and deciding whether the language switcher should offer a real link or say
 * "not available in Hindi yet".
 */
export async function getTranslations(postId: string) {
  const [self] = await db
    .select({
      id: posts.id,
      translationOfId: posts.translationOfId,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1)

  if (!self) return []

  // Walk up to the original first: a translation's siblings hang off it, not
  // off each other.
  const root = self.translationOfId ?? self.id

  return db
    .select({
      id: posts.id,
      slug: posts.slug,
      locale: posts.locale,
      title: posts.title,
      status: posts.status,
    })
    .from(posts)
    .where(
      and(
        or(eq(posts.id, root), eq(posts.translationOfId, root)),
        eq(posts.status, 'published')
      )
    )
}
