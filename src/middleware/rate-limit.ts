import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

import { env, isTest } from '../config/env.js'

/**
 * Rate limiting.
 *
 * Three tiers, because the cost of abuse differs wildly by endpoint:
 *
 *  - `apiLimiter`   broad ceiling on everything, to blunt scraping.
 *  - `authLimiter`  tight, per IP+email, on credential endpoints. Password
 *                   spraying is the attack this exists to stop, so the key
 *                   includes the targeted email: one IP trying 100 different
 *                   accounts must be limited even though each account is only
 *                   tried once.
 *  - `writeLimiter` on public writes (comments, newsletter) to stop spam
 *                   floods.
 *
 * In-memory store is correct for a single process. Running more than one PM2
 * instance needs the Redis store, or each process enforces its own quota —
 * see the note in `apiLimiter`.
 */

const skip = () => isTest

export const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  // PHASE 8: swap in rate-limit-redis once more than one process runs, so the
  // quota is global rather than per-instance.
  message: { error: 'Too many requests. Try again shortly.', code: 'rate_limited' },
})

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  // Counting successful logins against the limit would lock out a shared
  // office NAT doing nothing wrong.
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    // ipKeyGenerator normalises IPv6 to a /64 so a single client cannot
    // trivially rotate through addresses in its own subnet.
    const ip = ipKeyGenerator(req.ip ?? '')
    const email =
      typeof req.body === 'object' && req.body !== null && 'email' in req.body
        ? String((req.body as { email: unknown }).email).toLowerCase()
        : ''
    return `${ip}:${email}`
  },
  message: {
    error: 'Too many attempts. Try again in 15 minutes.',
    code: 'rate_limited',
  },
})

export const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  message: { error: 'Too many submissions. Try again later.', code: 'rate_limited' },
})
