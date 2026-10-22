import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque token helpers for refresh tokens, email verification, password
 * resets and newsletter confirmation.
 *
 * The raw token goes to the user exactly once; only its SHA-256 is stored.
 * A database leak therefore yields nothing usable, the same reasoning that
 * applies to passwords.
 *
 * SHA-256 (not bcrypt) is correct here: these tokens are 256 bits of CSPRNG
 * output, so they are not brute-forceable and need no key stretching.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Compares two hex digests without leaking where they first differ.
 * Lengths are checked first because timingSafeEqual throws on a mismatch.
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}
