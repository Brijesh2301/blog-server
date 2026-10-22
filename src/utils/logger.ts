import pino from 'pino'

import { env, isProduction } from '../config/env.js'

/**
 * Structured logger.
 *
 * Production emits newline-delimited JSON so a log shipper can parse it.
 * Development uses pino-pretty only if it is installed, so a missing optional
 * dev dependency degrades to JSON instead of crashing the process.
 *
 * `redact` is not optional: request logging would otherwise write auth
 * cookies and bearer tokens straight into the log store.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordConfirm',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }),
})
