import jwt, { type SignOptions } from 'jsonwebtoken'

import { env, jwtAccessSecret, jwtRefreshSecret } from '../config/env.js'
import type { UserRole } from '../db/schema.js'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * JWT
 * ─────────────────────────────────────────────────────────────────────────────
 * Two tokens with different jobs and different secrets:
 *
 *  access  — 15 minutes, carries the role claim, never stored server-side.
 *            Short-lived because revoking it is impossible.
 *  refresh — opaque random string (see lib/tokens.ts), NOT a JWT, stored
 *            hashed in `refresh_tokens` so it can be revoked and rotated.
 *
 * Using separate secrets means an access token can never be replayed as a
 * refresh token even if one signing key leaks.
 */

export type AccessTokenPayload = {
  sub: string
  role: UserRole
  email: string
}

const ISSUER = 'devlume-api'
const AUDIENCE = 'devlume-web'

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  }
  return jwt.sign(payload, jwtAccessSecret, options)
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, jwtAccessSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Pinning the algorithm blocks the `alg: none` and HS/RS confusion
      // attacks that come from trusting the token's own header.
      algorithms: ['HS256'],
    })
    if (typeof decoded === 'string') return null
    return decoded as AccessTokenPayload
  } catch {
    return null
  }
}

/**
 * Reserved for a future stateless refresh path. The current implementation
 * uses opaque refresh tokens so they can be revoked; this exists so the
 * secret is wired and the choice is explicit rather than forgotten.
 */
export { jwtRefreshSecret }
