import { Router } from 'express'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '../db/index.js'
import {
  categories,
  comments,
  postReactions,
  posts,
  subscribers,
  users,
} from '../db/schema.js'
import { generateToken, hashToken } from '../lib/tokens.js'
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth.js'
import { badRequest, notFound } from '../middleware/error.js'
import { logger } from '../utils/logger.js'
import { writeLimiter } from '../middleware/rate-limit.js'
import { body, params, query, validate } from '../middleware/validate.js'
import * as commentService from '../services/comment.service.js'
import { slugParam, uuidParam } from '../validators/common.schema.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ENGAGEMENT — comments, reactions, newsletter
 * ═════════════════════════════════════════════════════════════════════════════
 */
export const engagementRouter: Router = Router()

// ─────────────────────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────────────────────

/** Approved comments for a post, as a tree. Public and server-rendered. */
engagementRouter.get(
  '/posts/:slug/comments',
  validate({ params: slugParam }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)

    const [post] = await db
      .select({ id: posts.id, allowComments: posts.allowComments })
      .from(posts)
      .where(and(eq(posts.slug, slug), eq(posts.status, 'published')))
      .limit(1)

    if (!post) throw notFound('Post not found.')

    res.json({
      comments: await commentService.getCommentTree(post.id),
      allowComments: post.allowComments,
    })
  }
)

const commentInput = z.object({
  body: z
    .string()
    .trim()
    .min(2, 'Write something first.')
    .max(5000, 'Comments are limited to 5000 characters.'),
  parentId: z.uuid().optional(),
  // Guest fields, used only when not signed in.
  guestName: z.string().trim().min(2).max(80).optional(),
  guestEmail: z.email().max(254).optional(),
  /** Honeypot. A real user cannot see or focus this field. */
  website: z.string().max(200).optional(),
  elapsedMs: z.number().int().min(0).optional(),
})

engagementRouter.post(
  '/posts/:slug/comments',
  writeLimiter,
  optionalAuth,
  validate({ params: slugParam, body: commentInput }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)
    const input = body<z.infer<typeof commentInput>>(req)

    // Honeypot tripped. Return 202 so a bot cannot distinguish rejection from
    // success and retry with a different strategy.
    if (input.website) {
      res.status(202).json({ status: 'pending' })
      return
    }

    const [post] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.slug, slug), eq(posts.status, 'published')))
      .limit(1)
    if (!post) throw notFound('Post not found.')

    if (!req.user && !input.guestName) {
      throw badRequest('Add your name, or sign in to comment.')
    }

    const result = await commentService.createComment({
      postId: post.id,
      parentId: input.parentId,
      body: input.body,
      userId: req.user?.sub,
      guestName: req.user ? undefined : input.guestName,
      guestEmail: req.user ? undefined : input.guestEmail,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
      elapsedMs: input.elapsedMs,
    })

    res.status(201).json({
      status: result.status,
      // Honest about what happens next rather than implying it is live.
      message:
        result.status === 'approved'
          ? 'Your comment is live.'
          : 'Thanks — your comment is awaiting moderation.',
    })
  }
)

/** Moderation queue. */
engagementRouter.get(
  '/comments/pending',
  requireAuth,
  requireRole('admin', 'editor'),
  async (_req, res) => {
    const rows = await db
      .select({
        id: comments.id,
        body: comments.body,
        createdAt: comments.createdAt,
        guestName: comments.guestName,
        authorName: users.name,
        postSlug: posts.slug,
        postTitle: posts.title,
      })
      .from(comments)
      .leftJoin(posts, eq(posts.id, comments.postId))
      .leftJoin(users, eq(users.id, comments.userId))
      .where(eq(comments.status, 'pending'))
      .orderBy(desc(comments.createdAt))
      .limit(100)

    res.json({ comments: rows })
  }
)

engagementRouter.patch(
  '/comments/:id',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({
    params: uuidParam,
    body: z.object({ status: z.enum(['approved', 'spam', 'deleted']) }),
  }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    const { status } = body<{ status: 'approved' | 'spam' | 'deleted' }>(req)
    res.json({ comment: await commentService.moderateComment(id, status) })
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Reactions — likes and bookmarks
// ─────────────────────────────────────────────────────────────────────────────

const reactionInput = z.object({ type: z.enum(['like', 'bookmark']) })

/**
 * Toggles a reaction.
 *
 * Idempotent per (post, user, type) thanks to the unique index: a double-click
 * toggles twice and lands where it started, rather than inserting a duplicate
 * and inflating the count.
 */
engagementRouter.post(
  '/posts/:slug/reactions',
  requireAuth,
  validate({ params: slugParam, body: reactionInput }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)
    const { type } = body<z.infer<typeof reactionInput>>(req)
    const userId = req.user!.sub

    const [post] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.slug, slug), eq(posts.status, 'published')))
      .limit(1)
    if (!post) throw notFound('Post not found.')

    const [existing] = await db
      .select({ id: postReactions.id })
      .from(postReactions)
      .where(
        and(
          eq(postReactions.postId, post.id),
          eq(postReactions.userId, userId),
          eq(postReactions.type, type)
        )
      )
      .limit(1)

    if (existing) {
      await db.delete(postReactions).where(eq(postReactions.id, existing.id))
    } else {
      await db
        .insert(postReactions)
        .values({ postId: post.id, userId, type })
        // Belt and braces against a concurrent duplicate.
        .onConflictDoNothing()
    }

    if (type === 'like') await refreshLikeCount(post.id)

    const [counts] = await db
      .select({ likeCount: posts.likeCount })
      .from(posts)
      .where(eq(posts.id, post.id))
      .limit(1)

    res.json({ active: !existing, likeCount: counts?.likeCount ?? 0 })
  }
)

/** The current user's reactions for a post, so the UI can render its state. */
engagementRouter.get(
  '/posts/:slug/reactions',
  requireAuth,
  validate({ params: slugParam }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)

    const rows = await db
      .select({ type: postReactions.type })
      .from(postReactions)
      .innerJoin(posts, eq(posts.id, postReactions.postId))
      .where(and(eq(posts.slug, slug), eq(postReactions.userId, req.user!.sub)))

    res.json({
      liked: rows.some((row) => row.type === 'like'),
      bookmarked: rows.some((row) => row.type === 'bookmark'),
    })
  }
)

/**
 * Saved posts, for the reader's /saved screen.
 *
 * Returns the SAME card projection as every other listing, plus `savedAt`.
 * An earlier version returned a reduced shape of its own (a bare
 * `categoryName` string, no author, no counts) and the client then needed a
 * second card component that drifted from the real one. One projection, one
 * card, everywhere.
 *
 * `status = 'published'` is not optional: a post can be unpublished after
 * someone saved it, and a saved list is the one place a reader could
 * otherwise be handed a link to a draft.
 */
engagementRouter.get('/me/bookmarks', requireAuth, async (req, res) => {
  const rows = await db
    .select({ ...postCardColumns, savedAt: postReactions.createdAt })
    .from(postReactions)
    .innerJoin(posts, eq(posts.id, postReactions.postId))
    .leftJoin(users, eq(users.id, posts.authorId))
    .leftJoin(categories, eq(categories.id, posts.categoryId))
    .where(
      and(
        eq(postReactions.userId, req.user!.sub),
        eq(postReactions.type, 'bookmark'),
        eq(posts.status, 'published')
      )
    )
    .orderBy(desc(postReactions.createdAt))
    .limit(200)

  // Per-reader data. `private` keeps it out of any shared cache between here
  // and the browser — a CDN that cached this would serve one reader's saved
  // list to the next.
  res.set('Cache-Control', 'private, no-store')
  res.json({ bookmarks: rows })
})

/** The public card shape, matching `listColumns` in post.service.ts. */
const postCardColumns = {
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

async function refreshLikeCount(postId: string): Promise<void> {
  await db
    .update(posts)
    .set({
      likeCount: sql`(
        SELECT count(*)::int FROM ${postReactions}
        WHERE ${postReactions.postId} = ${postId} AND ${postReactions.type} = 'like'
      )`,
    })
    .where(eq(posts.id, postId))
}

// ─────────────────────────────────────────────────────────────────────────────
// Newsletter — double opt-in
// ─────────────────────────────────────────────────────────────────────────────

const subscribeInput = z.object({
  email: z.email('Enter a valid email address.').max(254),
  source: z.string().max(40).optional(),
  /** Honeypot. */
  company: z.string().max(200).optional(),
  elapsedMs: z.number().int().min(0).optional(),
})

/**
 * Double opt-in subscribe.
 *
 * The response is deliberately IDENTICAL whether or not the address was
 * already subscribed. Saying "you are already subscribed" turns the form into
 * an oracle for checking whether someone reads this site.
 */
engagementRouter.post(
  '/newsletter/subscribe',
  writeLimiter,
  validate({ body: subscribeInput }),
  async (req, res) => {
    const input = body<z.infer<typeof subscribeInput>>(req)

    if (
      input.company ||
      (input.elapsedMs !== undefined && input.elapsedMs > 0 && input.elapsedMs < 1500)
    ) {
      res.status(202).json({ status: 'pending_confirmation' })
      return
    }

    const email = input.email.trim().toLowerCase()
    const token = generateToken(24)

    await db
      .insert(subscribers)
      .values({
        email,
        status: 'pending',
        tokenHash: hashToken(token),
        source: input.source ?? null,
      })
      // Re-subscribing, or subscribing again before confirming, just issues a
      // fresh token rather than erroring.
      .onConflictDoUpdate({
        target: subscribers.email,
        set: { tokenHash: hashToken(token), status: 'pending' },
      })

    // PHASE 8: send the confirmation email via Resend. Until then the token is
    // logged so the flow is exercisable end to end in development.
    logger.info(
      { email, confirmUrl: `/newsletter/confirm?token=${token}` },
      'newsletter confirmation pending'
    )

    res.status(202).json({ status: 'pending_confirmation' })
  }
)

engagementRouter.get(
  '/newsletter/confirm',
  validate({ query: z.object({ token: z.string().min(16).max(256) }) }),
  async (req, res) => {
    const { token } = query<{ token: string }>(req)

    const [updated] = await db
      .update(subscribers)
      .set({ status: 'confirmed', confirmedAt: new Date(), tokenHash: null })
      .where(
        and(
          eq(subscribers.tokenHash, hashToken(token)),
          eq(subscribers.status, 'pending')
        )
      )
      .returning({ email: subscribers.email })

    if (!updated) throw badRequest('That confirmation link is invalid or already used.')
    res.json({ status: 'confirmed', email: updated.email })
  }
)

engagementRouter.post(
  '/newsletter/unsubscribe',
  validate({ body: z.object({ email: z.email().max(254) }) }),
  async (req, res) => {
    const { email } = body<{ email: string }>(req)

    await db
      .update(subscribers)
      .set({ status: 'unsubscribed', unsubscribedAt: new Date(), tokenHash: null })
      .where(eq(subscribers.email, email.trim().toLowerCase()))

    // Always 200: confirming whether the address was subscribed would leak it.
    res.json({ status: 'unsubscribed' })
  }
)
