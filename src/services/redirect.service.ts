import { and, eq, ne, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { redirects } from '../db/schema.js'
import { normalisePath } from '../lib/slug.js'
import { logger } from '../utils/logger.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * REDIRECT ENGINE
 * ═════════════════════════════════════════════════════════════════════════════
 * Changing a published post's slug changes its URL, and every existing link
 * and every indexed result still points at the old one. A 301 is the only
 * thing that carries ranking signals across, so creating it is automatic
 * rather than something an editor has to remember.
 *
 * Three rules make the table safe to apply blindly:
 *
 *  1. NO CHAINS. When `/a -> /b` exists and `/b` then moves to `/c`, every row
 *     pointing at `/b` is repointed at `/c`. Chains cost an extra round trip
 *     per hop and Google stops following them after about five.
 *
 *  2. NO LOOPS. A row whose source equals its destination is never written,
 *     and the repoint step skips any row that would become self-referential.
 *
 *  3. ONE DESTINATION PER SOURCE, enforced by the unique index on
 *     `from_path`, so recording the same move twice is idempotent.
 */

export type CreateRedirectInput = {
  from: string
  to: string
  statusCode?: 301 | 302 | 307 | 308 | 410
  reason?: 'slug_change' | 'manual' | 'merge' | 'delete'
  postId?: string | null
}

/**
 * Records a move and repairs any chain it would create.
 *
 * Runs in a transaction: a half-applied chain repair would leave rows pointing
 * at a URL that no longer resolves.
 */
export async function recordMove(input: CreateRedirectInput): Promise<void> {
  const from = normalisePath(input.from)
  const to = normalisePath(input.to)

  const statusCode = input.statusCode ?? 301

  // Rule 2: a self-referential REDIRECT is an infinite loop. A 410 row is not
  // a redirect though — it is a "this URL is intentionally gone" marker, and
  // for that case from === to is the correct and expected shape.
  if (from === to && statusCode !== 410) return
  const reason = input.reason ?? 'slug_change'

  // A 410 marker replaces any redirect that pointed at this path: the content
  // is gone, so sending readers onward to it would be a lie.
  if (statusCode === 410) {
    await db
      .insert(redirects)
      .values({ fromPath: from, toPath: to, statusCode, reason, postId: null })
      .onConflictDoUpdate({
        target: redirects.fromPath,
        set: { toPath: to, statusCode, reason },
      })
    return
  }

  await db.transaction(async (tx) => {
    // Rule 1: anything that pointed at the OLD path now points at the new one.
    const repointed = await tx
      .update(redirects)
      .set({ toPath: to })
      .where(and(eq(redirects.toPath, from), ne(redirects.fromPath, to)))
      .returning({ fromPath: redirects.fromPath })

    // If the destination itself was previously a redirect source, that row is
    // now stale: the page lives there again.
    await tx.delete(redirects).where(eq(redirects.fromPath, to))

    await tx
      .insert(redirects)
      .values({
        fromPath: from,
        toPath: to,
        statusCode,
        reason,
        postId: input.postId ?? null,
      })
      // Idempotent: re-recording the same move just refreshes the target.
      .onConflictDoUpdate({
        target: redirects.fromPath,
        set: { toPath: to, statusCode, reason },
      })

    if (repointed.length) {
      logger.info({ from, to, repointed: repointed.length }, 'redirect chain flattened')
    }
  })
}

/**
 * Resolves a path to its redirect target, or null.
 *
 * Increments the hit counter so the admin can spot redirects that are still
 * carrying real traffic (worth keeping) versus ones that are not (safe to
 * retire). The counter update is fire-and-forget: a failed statistic must
 * never turn a working redirect into a 500.
 */
export async function resolveRedirect(
  path: string
): Promise<{ to: string; statusCode: number } | null> {
  const from = normalisePath(path)

  const [row] = await db
    .select({
      id: redirects.id,
      toPath: redirects.toPath,
      statusCode: redirects.statusCode,
    })
    .from(redirects)
    .where(eq(redirects.fromPath, from))
    .limit(1)

  if (!row) return null

  void db
    .update(redirects)
    .set({
      hitCount: sql`${redirects.hitCount} + 1`,
      lastHitAt: new Date(),
    })
    .where(eq(redirects.id, row.id))
    .catch((error: unknown) => {
      logger.warn({ err: error, from }, 'failed to record redirect hit')
    })

  return { to: row.toPath, statusCode: row.statusCode }
}

/** Bulk lookup for the frontend, which fetches the whole table and caches it. */
export async function listRedirects(): Promise<
  { from: string; to: string; statusCode: number }[]
> {
  const rows = await db
    .select({
      from: redirects.fromPath,
      to: redirects.toPath,
      statusCode: redirects.statusCode,
    })
    .from(redirects)

  return rows
}

/**
 * Removes a redirect. Used when an editor deliberately reuses an old slug.
 */
export async function deleteRedirect(from: string): Promise<boolean> {
  const deleted = await db
    .delete(redirects)
    .where(eq(redirects.fromPath, normalisePath(from)))
    .returning({ id: redirects.id })
  return deleted.length > 0
}
