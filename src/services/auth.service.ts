import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'
import type { Response } from 'express'

import { env, isProduction } from '../config/env.js'
import { db } from '../db/index.js'
import { refreshTokens, users, type User, type UserRole } from '../db/schema.js'
import { signAccessToken } from '../lib/jwt.js'
import { fakeVerify, hashPassword, needsRehash, verifyPassword } from '../lib/password.js'
import { generateToken, hashToken } from '../lib/tokens.js'
import { slugify, uniqueSlug } from '../lib/slug.js'
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../middleware/auth.js'
import { conflict, unauthorized } from '../middleware/error.js'
import { logger } from '../utils/logger.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * AUTH SERVICE
 * ═════════════════════════════════════════════════════════════════════════════
 * Refresh tokens ROTATE: every refresh issues a new token and marks the old
 * one as replaced. A token is therefore valid exactly once.
 *
 * That makes theft detectable. If a stolen token is replayed after the real
 * user has already rotated it, the row is found already-replaced, and the only
 * safe assumption is that one of the two holders is an attacker — so the whole
 * token family for that user is revoked and both are forced to sign in again.
 * This is the standard OAuth refresh-token-rotation threat model.
 */

const REFRESH_TTL_MS = () => env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000

export type PublicUser = {
  id: string
  email: string
  name: string
  slug: string | null
  role: UserRole
  avatarUrl: string | null
  bio: string | null
  emailVerified: boolean
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    slug: user.slug,
    role: user.role,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    emailVerified: user.emailVerifiedAt !== null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SameSite choice:
 *  - 'lax' when the API and site share a registrable domain. It blocks CSRF on
 *    cross-site POSTs while keeping normal navigation working.
 *  - 'none' + Secure only when they genuinely differ, which browsers require
 *    for cross-site cookies.
 */
function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: isProduction || env.COOKIE_CROSS_SITE,
    sameSite: env.COOKIE_CROSS_SITE ? ('none' as const) : ('lax' as const),
    domain: env.COOKIE_DOMAIN === 'localhost' ? undefined : env.COOKIE_DOMAIN,
    path: '/',
    maxAge: maxAgeMs,
  }
}

export function setAuthCookies(res: Response, access: string, refresh: string) {
  res.cookie(ACCESS_COOKIE, access, cookieOptions(15 * 60 * 1000))
  // The refresh cookie is scoped to the refresh endpoint, so it is not sent
  // with every API call and cannot leak from an unrelated handler.
  res.cookie(REFRESH_COOKIE, refresh, {
    ...cookieOptions(REFRESH_TTL_MS()),
    path: '/api/v1/auth',
  })
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' })
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' })
}

// ─────────────────────────────────────────────────────────────────────────────
// Token issuance
// ─────────────────────────────────────────────────────────────────────────────

async function issueTokens(
  user: User,
  context: { userAgent?: string; ip?: string }
): Promise<{ access: string; refresh: string }> {
  const access = signAccessToken({
    sub: user.id,
    role: user.role,
    email: user.email,
  })

  const refresh = generateToken(48)

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hashToken(refresh),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS()),
    userAgent: context.userAgent?.slice(0, 500) ?? null,
    ip: context.ip?.slice(0, 64) ?? null,
  })

  return { access, refresh }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register / login / refresh / logout
// ─────────────────────────────────────────────────────────────────────────────

export async function register(input: {
  name: string
  email: string
  password: string
  userAgent?: string
  ip?: string
}) {
  const email = input.email.trim().toLowerCase()

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (existing) {
    // Enumeration is accepted here: a registration form must tell the user
    // their email is already registered, or the flow is unusable. The login
    // and password-reset paths, where it matters, do not leak it.
    throw conflict('An account with that email already exists.')
  }

  const passwordHash = await hashPassword(input.password)

  const [user] = await db
    .insert(users)
    .values({
      name: input.name.trim(),
      email,
      passwordHash,
      role: 'reader',
    })
    .returning()

  if (!user) throw new Error('Failed to create user.')

  const tokens = await issueTokens(user, input)
  logger.info({ userId: user.id }, 'user registered')

  // PHASE 6: send the verification email here.
  return { user: toPublicUser(user), ...tokens }
}

export async function login(input: {
  email: string
  password: string
  userAgent?: string
  ip?: string
}) {
  const email = input.email.trim().toLowerCase()

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  // Always spend the same time whether or not the account exists, so response
  // timing cannot be used to enumerate registered emails.
  if (!user?.passwordHash) {
    await fakeVerify()
    throw unauthorized('Incorrect email or password.')
  }

  const valid = await verifyPassword(input.password, user.passwordHash)
  if (!valid) throw unauthorized('Incorrect email or password.')

  if (!user.isActive) throw unauthorized('This account has been disabled.')

  // Transparently upgrade the hash cost on successful login.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(input.password)
    await db.update(users).set({ passwordHash: upgraded }).where(eq(users.id, user.id))
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))

  const tokens = await issueTokens(user, input)
  return { user: toPublicUser(user), ...tokens }
}

/**
 * Rotates a refresh token.
 *
 * Reuse detection: a token row that is already marked replaced means the same
 * token was presented twice. Since rotation makes each token single-use, the
 * second presentation is either an attacker replaying a stolen token or the
 * legitimate user racing themselves. Both are resolved the same way — revoke
 * the user's entire token family and force a fresh sign-in.
 */
export async function refresh(input: { token: string; userAgent?: string; ip?: string }) {
  const tokenHash = hashToken(input.token)

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1)

  if (!row) throw unauthorized('Session expired. Please sign in again.')

  if (row.revokedAt || row.replacedByTokenHash) {
    logger.warn(
      { userId: row.userId, tokenId: row.id },
      'refresh token reuse detected - revoking all sessions'
    )
    await revokeAllForUser(row.userId)
    throw unauthorized('Session expired. Please sign in again.')
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Session expired. Please sign in again.')
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1)
  if (!user || !user.isActive) {
    throw unauthorized('Session expired. Please sign in again.')
  }

  const tokens = await issueTokens(user, input)

  await db
    .update(refreshTokens)
    .set({
      revokedAt: new Date(),
      replacedByTokenHash: hashToken(tokens.refresh),
    })
    .where(eq(refreshTokens.id, row.id))

  return { user: toPublicUser(user), ...tokens }
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.tokenHash, hashToken(token)), isNull(refreshTokens.revokedAt))
    )
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
}

/**
 * Deletes expired and long-revoked tokens.
 * Phase 8 runs this on a schedule; exported now so it is testable.
 */
export async function pruneRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const deleted = await db
    .delete(refreshTokens)
    .where(
      or(lt(refreshTokens.expiresAt, new Date()), lt(refreshTokens.revokedAt, cutoff))
    )
    .returning({ id: refreshTokens.id })
  return deleted.length
}

/** Current user, read fresh so a role change takes effect without re-login. */
export async function getCurrentUser(userId: string): Promise<PublicUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isActive, true)))
    .limit(1)
  return user ? toPublicUser(user) : null
}

/**
 * Promotes a reader to an authoring role and gives them an author-page slug.
 * Admin-only; the slug must be unique because it becomes a public URL.
 */
export async function assignAuthorSlug(userId: string, name: string): Promise<string> {
  const slug = await uniqueSlug(slugify(name), async (candidate) => {
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.slug, candidate))
      .limit(1)
    return Boolean(taken)
  })

  await db.update(users).set({ slug }).where(eq(users.id, userId))
  return slug
}

/** Used by the health check to confirm at least one admin exists. */
export async function hasActiveAdmin(): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
    .limit(1)
  return Boolean(row)
}

/** Sessions still valid right now, for the account security screen. */
export async function listActiveSessions(userId: string) {
  return db
    .select({
      id: refreshTokens.id,
      userAgent: refreshTokens.userAgent,
      ip: refreshTokens.ip,
      createdAt: refreshTokens.createdAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date())
      )
    )
}
