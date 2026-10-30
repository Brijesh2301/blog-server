import 'dotenv/config'
import { z } from 'zod'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ENVIRONMENT
 * ─────────────────────────────────────────────────────────────────────────────
 * Parsed and validated once, at boot, before anything else runs.
 *
 * Failing here turns a missing secret into a startup crash with a precise
 * message, instead of a 500 at 3am on the one route that needed it.
 *
 * Secrets that are optional in development are REQUIRED in production — see
 * the `superRefine` at the bottom. That is the difference between a config
 * schema and a config contract.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),




  /** Comma-separated browser origins allowed to send credentials. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),


  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),


  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required, e.g. postgresql://user:pass@host:5432/db'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  /** True behind PgBouncer in transaction mode: disables prepared statements. */
  DATABASE_USES_POOLER: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  REDIS_URL: z.string().optional(),

  // ── Auth ──────────────────────────────────────────────────────────────────
  // 32 bytes minimum. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().default('localhost'),
  /** Set true when the API and site are on different registrable domains. */
  COOKIE_CROSS_SITE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // ── Frontend coupling ─────────────────────────────────────────────────────
  SITE_URL: z.string().url().default('http://localhost:3000'),

  /**
   * This API's own public origin.
   *
   * Uploaded media URLs are stored ABSOLUTE, because they are rendered by the
   * admin and the public site — potentially on different origins — and a
   * relative path would resolve against whichever one happened to render it.
   * It must therefore be the origin a BROWSER can reach, which behind a
   * reverse proxy is not the same as the port the process listens on.
   */
  API_PUBLIC_URL: z.string().url().default('http://localhost:5000'),
  FRONTEND_REVALIDATE_URL: z.string().url().optional(),
  REVALIDATE_SECRET: z.string().optional(),
  INDEXNOW_KEY: z.string().optional(),

  // ── Phase 6 ───────────────────────────────────────────────────────────────
  TTS_PROVIDER: z.enum(['openai', 'elevenlabs', 'google', 'azure']).optional(),
  TTS_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(25),
  RESEND_API_KEY: z.string().optional(),

  // ── Abuse control ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  TURNSTILE_SECRET_KEY: z.string().optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // Written straight to stderr: the logger itself depends on this config.
  console.error('\nInvalid environment configuration:\n')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
  console.error('\nSee server/.env.example for the full list.\n')
  process.exit(1)
}

const data = parsed.data

/**
 * Production hardening. These are optional in development so a fresh clone
 * boots with no setup, but a production process must never start without them.
 */
if (data.NODE_ENV === 'production') {
  const missing: string[] = []
  if (!data.JWT_ACCESS_SECRET) missing.push('JWT_ACCESS_SECRET')
  if (!data.JWT_REFRESH_SECRET) missing.push('JWT_REFRESH_SECRET')
  if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
    missing.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ')
  }
  if (missing.length) {
    console.error(
      `\nRefusing to start in production. Missing or invalid: ${missing.join(', ')}\n`
    )
    process.exit(1)
  }
}

export const env = data
export const isProduction = env.NODE_ENV === 'production'
export const isDevelopment = env.NODE_ENV === 'development'
export const isTest = env.NODE_ENV === 'test'

/**
 * Dev-only fallbacks so a fresh clone runs without generating secrets first.
 * The production guard above guarantees these can never be used for real.
 */
export const jwtAccessSecret =
  env.JWT_ACCESS_SECRET ?? 'dev-only-access-secret-do-not-use-in-production-32+'
export const jwtRefreshSecret =
  env.JWT_REFRESH_SECRET ?? 'dev-only-refresh-secret-do-not-use-in-production-32'
