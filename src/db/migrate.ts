import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

/**
 * Applies pending migrations from ./drizzle, then exits.
 *
 * Uses its own single connection rather than the shared app pool: migrations
 * take locks, and running them through a pool risks different statements
 * landing on different connections.
 *
 * `max: 1` is required by the migrator for exactly that reason.
 */
async function main() {
  const client = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} })
  const db = drizzle(client)

  logger.info('applying migrations...')
  const started = Date.now()

  try {
    await migrate(db, { migrationsFolder: './drizzle' })
    logger.info({ ms: Date.now() - started }, 'migrations applied')
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  logger.fatal({ err: error }, 'migration failed')
  process.exit(1)
})
