import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * PUBLISH SIDE EFFECTS
 * ═════════════════════════════════════════════════════════════════════════════
 * What happens after a post goes live, beyond writing the row:
 *
 *  1. REVALIDATE the frontend so the new URL is served immediately rather than
 *     when its cacheLife expires.
 *  2. PING IndexNow so Bing and Yandex fetch it within minutes instead of
 *     waiting for their next crawl.
 *
 * Both are FIRE AND FORGET. A failed cache purge or a rate-limited IndexNow
 * ping must never fail the publish — the editor has already done their job,
 * and the cacheLife plus the next sitemap crawl are the fallbacks. Every
 * failure is logged at warn so it is visible without being fatal.
 */

type RevalidateTarget = {
  type: 'post' | 'comments' | 'category' | 'tag' | 'author' | 'series' | 'all'
  slug?: string
}

/** Purges the frontend cache for one entity. */
export async function revalidateFrontend(target: RevalidateTarget): Promise<void> {
  if (!env.FRONTEND_REVALIDATE_URL || !env.REVALIDATE_SECRET) {
    logger.debug('revalidation not configured; skipping')
    return
  }

  try {
    const res = await fetch(env.FRONTEND_REVALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': env.REVALIDATE_SECRET,
      },
      body: JSON.stringify(target),
      // The publish response should not wait on a slow frontend.
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      logger.warn({ status: res.status, target }, 'revalidation rejected')
      return
    }
    logger.info({ target }, 'frontend revalidated')
  } catch (error) {
    logger.warn({ err: error, target }, 'revalidation failed')
  }
}

/**
 * IndexNow: tells Bing, Yandex and Seznam that a URL changed.
 *
 * The protocol requires a key file served at `https://<host>/<key>.txt`
 * containing exactly the key — that is how the endpoint verifies you control
 * the domain. The frontend serves it; see
 * `client/src/app/[key]/route.ts`.
 *
 * Google does NOT participate in IndexNow. It discovers changes through the
 * sitemap and its own crawl, which is why both still matter.
 */
export async function pingIndexNow(urls: string[]): Promise<void> {
  if (!env.INDEXNOW_KEY || urls.length === 0) return

  const host = new URL(env.SITE_URL).host

  // Never ping localhost: the endpoint would reject it, and in development it
  // is pure noise in the logs.
  if (host.startsWith('localhost') || host.startsWith('127.')) {
    logger.debug({ urls }, 'skipping IndexNow for a local host')
    return
  }

  try {
    const res = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key: env.INDEXNOW_KEY,
        keyLocation: `${env.SITE_URL}/${env.INDEXNOW_KEY}.txt`,
        // The API caps a submission at 10,000 URLs.
        urlList: urls.slice(0, 10_000),
      }),
      signal: AbortSignal.timeout(5000),
    })

    // 200 accepted, 202 accepted but key still validating — both are fine.
    if (res.status === 200 || res.status === 202) {
      logger.info({ count: urls.length, status: res.status }, 'IndexNow pinged')
    } else {
      logger.warn({ status: res.status }, 'IndexNow rejected the submission')
    }
  } catch (error) {
    logger.warn({ err: error }, 'IndexNow ping failed')
  }
}

/**
 * Everything that should happen when a post becomes publicly visible.
 *
 * Deliberately not awaited by the caller: see the note at the top of the file.
 */
export function onPostPublished(slug: string, categorySlug?: string | null): void {
  const url = `${env.SITE_URL}/blog/${slug}`

  void revalidateFrontend({ type: 'post', slug })
  if (categorySlug) void revalidateFrontend({ type: 'category', slug: categorySlug })
  void pingIndexNow([url, `${env.SITE_URL}/blog`, `${env.SITE_URL}/`])
}

/** A moved URL: the old one is gone and the new one is new, so submit both. */
export function onPostMoved(fromSlug: string, toSlug: string): void {
  void revalidateFrontend({ type: 'post', slug: fromSlug })
  void revalidateFrontend({ type: 'post', slug: toSlug })
  void pingIndexNow([
    `${env.SITE_URL}/blog/${fromSlug}`,
    `${env.SITE_URL}/blog/${toSlug}`,
  ])
}

export function onPostDeleted(slug: string): void {
  void revalidateFrontend({ type: 'all' })
  // Submitting a removed URL is correct: it prompts a recrawl, which finds
  // the 410 and drops it from the index faster than waiting would.
  void pingIndexNow([`${env.SITE_URL}/blog/${slug}`])
}
