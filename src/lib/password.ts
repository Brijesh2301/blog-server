import bcrypt from 'bcryptjs'

import { env } from '../config/env.js'

/**
 * Password hashing.
 *
 * bcrypt at cost 12 takes roughly 250ms on modern hardware, which is the point:
 * it makes offline cracking expensive. Raise BCRYPT_ROUNDS as hardware
 * improves; existing hashes keep their original cost and are upgraded on the
 * next successful login via `needsRehash`.
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS)
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

/** True when a stored hash was created with a lower cost than we now require. */
export function needsRehash(hash: string): boolean {
  const rounds = bcrypt.getRounds(hash)
  return rounds < env.BCRYPT_ROUNDS
}

/**
 * Constant-time-ish dummy verification.
 *
 * Called when a login targets an email that does not exist, so the response
 * takes the same time as a real password check. Without it, response timing
 * reveals which emails are registered.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.7Hx3xZ0pPrA3Ejq6Nxmg3hXxMLtXaKq'
export async function fakeVerify(): Promise<void> {
  await bcrypt.compare('not-a-real-password', DUMMY_HASH)
}
