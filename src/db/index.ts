import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'

import { env, isProduction } from '../config/env.js'
import { logger } from '../utils/logger.js'
import * as schema from './schema.js'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DATABASE CONNECTION
 * ─────────────────────────────────────────────────────────────────────────────
 * postgres.js over node-pg: it is faster, has first-class TypeScript types and
 * drizzle's postgres-js driver is the better-supported path.
 *
 * Pool sizing: `max` is per PROCESS. Running 4 PM2 instances against a default
 * Postgres (100 connections) with max=20 each would exhaust the server, so
 * this is deliberately conservative and configurable.
 */
const client = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  // Recycle idle connections so a restarted database does not leave the pool
  // holding dead sockets.
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  // Prepared statements must be off behind a transaction-mode pooler such as
  // PgBouncer; harmless when connecting directly.
  prepare: !env.DATABASE_USES_POOLER,
  onnotice: isProduction ? () => {} : (notice) => logger.debug({ notice }, 'pg notice'),
})

export const db = drizzle(client, {
  schema,
  logger: env.LOG_LEVEL === 'trace',
})

export { schema, client }

/** Liveness probe used by GET /health/ready. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now()
  try {
    await db.execute(sql`SELECT 1`)
    return { ok: true, latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    logger.error({ err: error }, 'database health check failed')
    return { ok: false, latencyMs: Math.round(performance.now() - started) }
  }
}

/** Closes the pool on shutdown so in-flight queries can finish. */
export async function closeDatabase(): Promise<void> {
  await client.end({ timeout: 5 })
}
