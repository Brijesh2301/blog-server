import { z } from 'zod'

/**
 * Password policy: length over composition rules.
 *
 * NIST SP 800-63B deprecated forced symbol/number mixes — they push people
 * toward predictable patterns like "Password1!" — and recommends a long
 * minimum plus a blocklist of common passwords instead.
 *
 * The 72-byte ceiling is bcrypt's: it silently truncates beyond that, so
 * accepting a longer password would create a false sense of strength.
 */
const password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(72, 'Passwords are limited to 72 characters.')
  .refine(
    (value) => !COMMON_PASSWORDS.has(value.toLowerCase()),
    'That password is too common. Pick something less guessable.'
  )

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '1234567890',
  'qwertyuiop',
  'letmein123',
  'iloveyou1',
  'admin12345',
  'welcome123',
  'changeme123',
])

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name.').max(120),
  email: z.email('Enter a valid email address.').max(254),
  password,
})

export const loginSchema = z.object({
  email: z.email('Enter a valid email address.').max(254),
  password: z.string().min(1, 'Enter your password.').max(72),
})

export const forgotPasswordSchema = z.object({
  email: z.email().max(254),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  password,
})

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  bio: z.string().trim().max(2000).optional(),
  jobTitle: z.string().trim().max(160).optional(),
  credentials: z.string().trim().max(500).optional(),
  avatarUrl: z.url().max(500).optional(),
  socials: z.record(z.string().max(30), z.url().max(300)).optional(),
  knowsAbout: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
