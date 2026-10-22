import type { NextFunction, Request, Response } from 'express'

import type { UserRole } from '../db/schema.js'
import { readCookie } from '../lib/cookies.js'
import { verifyAccessToken } from '../lib/jwt.js'
import { forbidden, unauthorized } from './error.js'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTHENTICATION + RBAC
 * ─────────────────────────────────────────────────────────────────────────────
 * The access token is read from an httpOnly cookie first and the
 * `Authorization` header second.
 *
 * Cookie-first because that is how the browser client authenticates, and an
 * httpOnly cookie cannot be read by injected JavaScript the way a token in
 * localStorage can. The header path exists for server-to-server callers and
 * for the API docs, which have no cookie jar.
 */

export const ACCESS_COOKIE = 'devlume_at'
export const REFRESH_COOKIE = 'devlume_rt'

function extractToken(req: Request): string | null {
  const fromCookie = readCookie(req, ACCESS_COOKIE)
  if (fromCookie) return fromCookie

  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null

  return null
}

/** Rejects the request unless a valid access token is present. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req)
  if (!token) return next(unauthorized('Sign in to continue.'))

  const payload = verifyAccessToken(token)
  if (!payload) return next(unauthorized('Your session has expired.'))

  req.user = payload
  next()
}

/**
 * Attaches the user when a valid token is present, but never rejects.
 *
 * Used on public reads that change shape for signed-in readers — a post
 * response that includes whether the current user has liked or bookmarked it.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req)
  if (token) {
    const payload = verifyAccessToken(token)
    if (payload) req.user = payload
  }
  next()
}

/**
 * Role gate. Must be mounted after requireAuth.
 *
 * Roles are NOT hierarchical by accident — the list is explicit at each call
 * site. `requireRole('admin', 'editor')` reads as exactly who may pass, which
 * avoids the classic bug where adding a role silently widens access
 * everywhere a numeric level comparison is used.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized('Sign in to continue.'))
    if (!roles.includes(req.user.role)) {
      return next(forbidden('You do not have permission to do that.'))
    }
    next()
  }
}

/**
 * Allows the listed roles, OR the owner of the resource.
 *
 * `getOwnerId` is async because ownership usually requires a lookup. It runs
 * only when the role check has already failed, so the common admin path costs
 * no extra query.
 */
export function requireRoleOrOwner(
  roles: UserRole[],
  getOwnerId: (req: Request) => Promise<string | null>
) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized('Sign in to continue.'))
    if (roles.includes(req.user.role)) return next()

    const ownerId = await getOwnerId(req)
    if (ownerId && ownerId === req.user.sub) return next()

    next(forbidden('You do not have permission to do that.'))
  }
}
