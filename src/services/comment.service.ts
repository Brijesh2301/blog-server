import { and, asc, eq, sql } from 'drizzle-orm'
import sanitizeHtml from 'sanitize-html'

import { db } from '../db/index.js'
import { comments, posts, users } from '../db/schema.js'
import { badRequest, notFound } from '../middleware/error.js'
import { revalidateFrontend } from './publish.service.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * COMMENTS
 * ═════════════════════════════════════════════════════════════════════════════
 * Threaded, moderated, and rendered into the page server-side so they are
 * crawlable — with `rel="ugc"` on every link a commenter writes.
 *
 * `rel="ugc"` matters: without it, a spammer who gets one comment approved is
 * passing link equity from our domain to theirs, which is exactly what comment
 * spam is for. `ugc` tells Google the link is user-generated and should not be
 * treated as an editorial endorsement.
 */

/**
 * Comment bodies allow a deliberately tiny subset of HTML.
 *
 * No images (tracking pixels), no headings (they would pollute the page's
 * document outline and compete with the article's own structure), no lists
 * beyond the basics. The goal is prose with the occasional link and code span.
 */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'code',
    'pre',
    'blockquote',
    'a',
    'ul',
    'ol',
    'li',
  ],
  allowedAttributes: {
    /*
     * `rel` and `target` MUST be listed here even though `transformTags`
     * below sets them itself.
     *
     * sanitize-html runs transforms first and filters attributes second, so
     * an allowlist of just `['href']` silently strips the rel that the
     * transform had just added — leaving every approved comment link as a
     * plain followable link out of our domain. That is the exact failure the
     * whole policy exists to prevent, and it is invisible unless you read the
     * rendered HTML.
     */
    a: ['href', 'rel', 'target'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        rel: 'ugc nofollow noopener noreferrer',
        target: '_blank',
      },
    }),
  },
}

/**
 * Plain text in, safe HTML out. Paragraphs come from blank lines.
 *
 * The order of the three steps is not interchangeable:
 *
 *   1. ESCAPE first, so everything the commenter typed is inert text before
 *      any markup of ours exists. Autolinking first would let an `<a href=…>`
 *      written in the body survive as a tag we did not build.
 *   2. AUTOLINK bare URLs — which is what makes the `rel` policy mean
 *      anything at all. Commenters type `https://…`, not anchors, so without
 *      this step no link is ever created and the sanitiser's rel-forcing
 *      never runs on anything.
 *   3. SANITISE last, which drops anything unexpected and stamps
 *      rel="ugc nofollow noopener noreferrer" onto every anchor regardless of
 *      where it came from.
 */
export function renderCommentHtml(body: string): string {
  const paragraphs = body
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${autolink(escapeHtml(block)).replace(/\n/g, '<br>')}</p>`)
    .join('\n')

  return sanitizeHtml(paragraphs, SANITIZE)
}

/**
 * Turns bare http(s) URLs in ALREADY-ESCAPED text into anchors.
 *
 * Operates on escaped input, so the only `<` and `>` in the string are ones
 * this function is about to add — there is no tag to break out of.
 *
 * The trailing-punctuation trim matters more than it looks: without it,
 * "see https://example.com." links the full stop too, and the link 404s for
 * everyone who clicks it.
 */
function autolink(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (match) => {
    // Stop at an escaped delimiter before trimming punctuation — otherwise a
    // perfectly ordinary comment breaks. See `cutAtEscapedDelimiter`.
    const candidate = cutAtEscapedDelimiter(match)

    const trailing = /[.,;:!?)\]}'"]+$/.exec(candidate)
    const url = trailing ? candidate.slice(0, -trailing[0].length) : candidate
    const tail = candidate.slice(url.length) + match.slice(candidate.length)

    // `&amp;` is already the correct attribute encoding for `&`, so what is
    // left goes straight into href with no further work.
    return `<a href="${url}">${shortenUrl(url)}</a>${tail}`
  })
}

/**
 * Trims an escaped delimiter off the end of a matched URL.
 *
 * The URL is matched in text that has ALREADY been HTML-escaped, so a quote
 * the commenter typed is sitting in the string as `&quot;` — six characters
 * that contain no whitespace and no `<`, and which the URL pattern therefore
 * happily swallows.
 *
 * The symptom is not subtle once you look at the output. `He said "go to
 * https://example.com/x" loudly` produced:
 *
 *   href="https://example.com/x&quot;"      — a link to the wrong URL
 *   >example.com/x"</a>;                    — and a stray semicolon in the text
 *
 * `&quot;` `&lt;` `&gt;` `&#39;` can only come from escaping, because those
 * characters are never literal in a URL — a real quote would be percent-
 * encoded. `&amp;` is deliberately NOT in the list: it is a genuine `&` in a
 * query string and must survive.
 */
function cutAtEscapedDelimiter(match: string): string {
  let cut = match.length

  for (const entity of ['&quot;', '&lt;', '&gt;', '&#39;']) {
    const at = match.indexOf(entity)
    if (at !== -1 && at < cut) cut = at
  }

  return match.slice(0, cut)
}

/**
 * Linked in full, displayed short.
 *
 * A 300-character URL pasted into a comment would otherwise blow out the text
 * column on a phone — and `overflow-wrap: anywhere` in the stylesheet would
 * then wrap it into an unreadable block.
 */
function shortenUrl(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//, '')
  return withoutScheme.length > 48 ? `${withoutScheme.slice(0, 48)}…` : withoutScheme
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type CommentNode = {
  id: string
  bodyHtml: string
  createdAt: Date
  parentId: string | null
  author: { name: string; slug: string | null; avatarUrl: string | null } | null
  guestName: string | null
  replies: CommentNode[]
}

/**
 * Approved comments for a post, as a tree.
 *
 * Fetched flat in ONE query and assembled in memory rather than recursing in
 * SQL: a comment thread is small, and a recursive CTE per page view costs more
 * than the assembly does.
 */
export async function getCommentTree(postId: string): Promise<CommentNode[]> {
  const rows = await db
    .select({
      id: comments.id,
      bodyHtml: comments.bodyHtml,
      createdAt: comments.createdAt,
      parentId: comments.parentId,
      guestName: comments.guestName,
      userName: users.name,
      userSlug: users.slug,
      userAvatar: users.avatarUrl,
    })
    .from(comments)
    .leftJoin(users, eq(comments.userId, users.id))
    .where(and(eq(comments.postId, postId), eq(comments.status, 'approved')))
    .orderBy(asc(comments.createdAt))

  const nodes = new Map<string, CommentNode>()
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      bodyHtml: row.bodyHtml,
      createdAt: row.createdAt,
      parentId: row.parentId,
      author: row.userName
        ? { name: row.userName, slug: row.userSlug, avatarUrl: row.userAvatar }
        : null,
      guestName: row.guestName,
      replies: [],
    })
  }

  const roots: CommentNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.replies.push(node)
    else roots.push(node)
  }

  return roots
}

export type CreateCommentInput = {
  postId: string
  parentId?: string
  body: string
  userId?: string
  guestName?: string
  guestEmail?: string
  ip?: string
  userAgent?: string
  /** Milliseconds between the form rendering and submitting. */
  elapsedMs?: number
}

/** Bots submit instantly; a human takes at least a few seconds to type. */
const MIN_ELAPSED_MS = 3_000

export async function createComment(input: CreateCommentInput) {
  const [post] = await db
    .select({ id: posts.id, allowComments: posts.allowComments, status: posts.status })
    .from(posts)
    .where(eq(posts.id, input.postId))
    .limit(1)

  if (!post || post.status !== 'published') throw notFound('Post not found.')
  if (!post.allowComments) throw badRequest('Comments are closed on this post.')

  // A reply must belong to the same post, or a crafted parentId could graft a
  // thread from one article onto another.
  if (input.parentId) {
    const [parent] = await db
      .select({ postId: comments.postId })
      .from(comments)
      .where(eq(comments.id, input.parentId))
      .limit(1)
    if (!parent || parent.postId !== input.postId) {
      throw badRequest('That comment does not belong to this post.')
    }
  }

  const bodyHtml = renderCommentHtml(input.body)
  if (!bodyHtml.trim()) throw badRequest('Write something first.')

  /**
   * Moderation policy.
   *
   * Signed-in users are auto-approved; guests are held. Anything containing a
   * link is held regardless of who wrote it, because links are what comment
   * spam exists to place — and a spammer with an account is still a spammer.
   */
  const containsLink = /https?:\/\//i.test(input.body)
  const tooFast =
    input.elapsedMs !== undefined &&
    input.elapsedMs > 0 &&
    input.elapsedMs < MIN_ELAPSED_MS

  const status =
    input.userId && !containsLink && !tooFast
      ? ('approved' as const)
      : ('pending' as const)

  const [created] = await db
    .insert(comments)
    .values({
      postId: input.postId,
      parentId: input.parentId ?? null,
      userId: input.userId ?? null,
      guestName: input.guestName ?? null,
      guestEmail: input.guestEmail ?? null,
      body: input.body,
      bodyHtml,
      status,
      ip: input.ip?.slice(0, 64) ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
    })
    .returning()

  if (created && status === 'approved') await publishThreadChange(input.postId)

  return { comment: created, status }
}

/**
 * Approve, mark as spam, or delete.
 *
 * Approving RE-RENDERS the stored HTML from the raw body rather than
 * publishing whatever was rendered at submission time. The raw `body` is the
 * source of truth; `bodyHtml` is a cache of the current sanitiser policy —
 * and that policy changes. A comment submitted last month under a looser
 * allowlist must not be published today under the markup it got then, and
 * re-rendering here means a policy fix reaches everything still in the queue
 * without a migration.
 */
export async function moderateComment(
  id: string,
  status: 'approved' | 'spam' | 'deleted'
) {
  const [existing] = await db
    .select({ body: comments.body })
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1)

  if (!existing) throw notFound('Comment not found.')

  const [updated] = await db
    .update(comments)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === 'approved' ? { bodyHtml: renderCommentHtml(existing.body) } : {}),
    })
    .where(eq(comments.id, id))
    .returning({ id: comments.id, postId: comments.postId })

  if (!updated) throw notFound('Comment not found.')
  await publishThreadChange(updated.postId)
  return updated
}

/**
 * Recomputed, not incremented.
 *
 * A counter that drifts stays wrong forever, and this one is displayed on
 * every card. Recomputing is one indexed count over a small set.
 */
async function refreshCommentCount(postId: string): Promise<void> {
  await db
    .update(posts)
    .set({
      commentCount: sql`(
        SELECT count(*)::int FROM ${comments}
        WHERE ${comments.postId} = ${postId} AND ${comments.status} = 'approved'
      )`,
    })
    .where(eq(posts.id, postId))
}

/**
 * Recounts, then purges the frontend's cached thread.
 *
 * Without the purge, an approved comment would sit invisible until the
 * thread's `cacheLife('minutes')` lapsed — and a reader who posts a comment,
 * sees "your comment is live", reloads and cannot find it will reasonably
 * assume it was lost and post again.
 *
 * Fire and forget, like every other revalidation: the comment is already
 * stored, and a failed purge costs a minute of staleness, not data.
 */
async function publishThreadChange(postId: string): Promise<void> {
  await refreshCommentCount(postId)

  const [post] = await db
    .select({ slug: posts.slug })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1)

  if (post) void revalidateFrontend({ type: 'comments', slug: post.slug })
}
