import { Router } from 'express'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '../db/index.js'
import { posts } from '../db/schema.js'
import {
  optionalAuth,
  requireAuth,
  requireRole,
  requireRoleOrOwner,
} from '../middleware/auth.js'
import { notFound } from '../middleware/error.js'
import { body, params, query, validate } from '../middleware/validate.js'
import * as postService from '../services/post.service.js'
import { paginated, slugParam, uuidParam } from '../validators/common.schema.js'
import {
  createPostSchema,
  listPostsQuery,
  postLocale,
  updatePostSchema,
  type CreatePostInput,
  type ListPostsQuery,
  type UpdatePostInput,
} from '../validators/post.schema.js'

export const postsRouter: Router = Router()

/** Looks up a post's author, for the owner branch of the RBAC check. */
async function postOwner(req: { params: Record<string, string> }) {
  const id = req.params.id
  if (!id) return null
  const [row] = await db
    .select({ authorId: posts.authorId })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1)
  return row?.authorId ?? null
}

// ── Public reads ────────────────────────────────────────────────────────────

postsRouter.get(
  '/',
  optionalAuth,
  validate({ query: listPostsQuery }),
  async (req, res) => {
    const q = query<ListPostsQuery>(req)

    // Only staff may request a non-published status. Without this, adding
    // ?status=draft to a public URL would leak unpublished work.
    const isStaff =
      req.user?.role === 'admin' ||
      req.user?.role === 'editor' ||
      req.user?.role === 'author'
    const safeQuery = isStaff ? q : { ...q, status: 'published' as const }

    const { rows, total } = await postService.listPosts(safeQuery)
    res.json(paginated(rows, total, q))
  }
)

postsRouter.get(
  '/:slug',
  optionalAuth,
  validate({ params: slugParam, query: z.object({ locale: postLocale.optional() }) }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)
    const { locale } = query<{ locale?: 'en' | 'hi' }>(req)
    const isStaff =
      req.user?.role === 'admin' ||
      req.user?.role === 'editor' ||
      req.user?.role === 'author'

    /*
     * The locale is part of the LOOKUP, not a filter applied afterwards.
     *
     * Slugs are unique per (slug, locale), so resolving `why-x` without one
     * returns whichever row Postgres reaches first — which is how a Hindi URL
     * ends up rendering the English article.
     */
    const post = await postService.getPostBySlug(slug, isStaff, locale)
    if (!post) throw notFound('Post not found.')

    res.json({ post, translations: await postService.getTranslations(post.id) })
  }
)

/**
 * Related posts.
 *
 * A dedicated endpoint rather than a filtered listing, because the ranking is
 * a blend of tags, category, series and popularity that a query string cannot
 * express — and because these links are the site's internal crawl paths, so
 * they are worth ranking properly.
 */
postsRouter.get(
  '/:slug/related',
  validate({
    params: slugParam,
    query: z.object({ limit: z.coerce.number().int().min(1).max(12).default(3) }),
  }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)
    const { limit } = query<{ limit: number }>(req)

    res.set(
      'Cache-Control',
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
    )
    res.json({ items: await postService.getRelatedPosts(slug, limit) })
  }
)

// ── Authenticated writes ────────────────────────────────────────────────────

postsRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'editor', 'author'),
  validate({ body: createPostSchema }),
  async (req, res) => {
    const input = body<CreatePostInput>(req)
    const post = await postService.createPost(input, req.user!.sub)
    res.status(201).json({ post })
  }
)

postsRouter.patch(
  '/:id',
  requireAuth,
  validate({ params: uuidParam, body: updatePostSchema }),
  // An author may edit their own posts; editors and admins may edit any.
  requireRoleOrOwner(['admin', 'editor'], (req) =>
    postOwner(req as unknown as { params: Record<string, string> })
  ),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    const post = await postService.updatePost(id, body<UpdatePostInput>(req))
    res.json({ post })
  }
)

postsRouter.delete(
  '/:id',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ params: uuidParam }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    await postService.deletePost(id)
    res.status(204).end()
  }
)
