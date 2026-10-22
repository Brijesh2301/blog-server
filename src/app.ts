import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import pinoHttp from 'pino-http'

import { env, isProduction } from './config/env.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'
import { apiLimiter } from './middleware/rate-limit.js'
import { apiRouter } from './routes/index.js'
import { healthRouter } from './routes/health.js'
import { UPLOAD_ROOT } from './services/media.service.js'
import { logger } from './utils/logger.js'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPRESS APP
 * ─────────────────────────────────────────────────────────────────────────────
 * Middleware order is load-bearing and is the reason this file exists
 * separately from index.ts (which only owns the listener + shutdown):
 *
 *   1. trust proxy  — before anything reads req.ip, or rate limiting behind
 *                     Nginx would see one IP for the whole internet.
 *   2. helmet       — before any route can respond.
 *   3. cors         — before the body parser, so a rejected preflight never
 *                     costs a parse.
 *   4. body parsers — with a size cap.
 *   5. compression  — after parsers, before routes.
 *   6. logging      — wraps the routes it reports on.
 *   7. routes
 *   8. 404 then error handler — must be last, in that order.
 */
export function createApp() {
  const app = express()

  // Behind Nginx/Vercel, the client IP is in X-Forwarded-For. Without this,
  // req.ip is the proxy and every per-IP limit becomes global.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(
    helmet({
      // This API serves JSON, not documents, so a document CSP is not useful.
      // The frontend sets its own; see client/next.config.ts.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: isProduction
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false,
    })
  )

  app.use(
    cors({
      // Explicit allowlist, not a reflector: `credentials: true` with a
      // reflected origin would let any site make authenticated requests.
      origin(origin, callback) {
        // Same-origin and server-to-server requests send no Origin header.
        if (!origin) return callback(null, true)
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true)
        return callback(new Error(`Origin ${origin} is not allowed.`))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 86_400,
    })
  )

  // 1mb is generous for JSON and well under what would let a single request
  // exhaust memory. Image uploads are multipart and bypass this entirely —
  // multer parses them, with its own size limit, on the one route that
  // accepts them.
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))
  // Auth tokens travel as httpOnly cookies, so they must be parsed before any
  // route that calls requireAuth.
  app.use(cookieParser())

  /*
   * Uploaded media.
   *
   * Every file here was written by the media service, which re-encoded it to
   * WebP — so the bytes on disk are ones we produced, not ones a user sent.
   * That is what makes serving this directory safe.
   *
   * `dotfiles: 'deny'` and `index: false` because a static mount should never
   * expose a directory listing or a stray dotfile. Filenames are
   * content-addressed and never reused, so `immutable` is honest: the bytes at
   * a given URL cannot change.
   */
  app.use(
    '/uploads',
    express.static(UPLOAD_ROOT, {
      dotfiles: 'deny',
      index: false,
      maxAge: '1y',
      immutable: true,
      setHeaders(res) {
        // Belt and braces: these are images, and must never be sniffed into
        // anything executable.
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      },
    })
  )

  app.use(compression())

  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise dominate the log volume.
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/health/ready',
      },
      customLogLevel(_req, res, err) {
        if (err || res.statusCode >= 500) return 'error'
        if (res.statusCode >= 400) return 'warn'
        return 'info'
      },
    })
  )

  // ── Routes ────────────────────────────────────────────────────────────────
  // Health is mounted BEFORE the rate limiter: a liveness probe polling every
  // few seconds must never be throttled into reporting the service as down.
  app.use('/health', healthRouter)

  app.use('/api/v1', apiLimiter, apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
