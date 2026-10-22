import { createApp } from './app.js'
import { env } from './config/env.js'
import { checkDatabase, closeDatabase } from './db/index.js'
import { logger } from './utils/logger.js'

/**
 * Process entry point. Owns the listener and the shutdown path only —
 * everything about the application itself lives in app.ts.
 */
const app = createApp()

// Fail fast on a bad DATABASE_URL: starting and then 500ing every request is
// far harder to diagnose than refusing to start.
const dbCheck = await checkDatabase()
if (!dbCheck.ok) {
  logger.fatal('cannot reach the database - check DATABASE_URL')
  process.exit(1)
}
logger.info({ latencyMs: dbCheck.latencyMs }, 'database connected')

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    `Devlume API listening on http://localhost:${env.PORT}`
  )
})

/**
 * Graceful shutdown.
 *
 * PM2 and Docker send SIGTERM and then SIGKILL after a grace period. Closing
 * the server first lets in-flight requests finish instead of being severed
 * mid-response; the timeout guarantees we exit even if a socket hangs.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')

  const forceExit = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit')
    process.exit(1)
  }, 10_000)
  // Do not let this timer hold the event loop open on a clean exit.
  forceExit.unref()

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'error during shutdown')
      process.exit(1)
    }
    // Close the pool after the HTTP server, so in-flight queries finish.
    void closeDatabase()
      .catch((err: unknown) => logger.error({ err }, 'error closing database'))
      .finally(() => {
        logger.info('shutdown complete')
        process.exit(0)
      })
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// A process in an unknown state must not keep serving traffic; log and let the
// supervisor restart it clean.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection')
  shutdown('unhandledRejection')
})
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception')
  shutdown('uncaughtException')
})
