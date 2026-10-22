import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

import { isProduction } from '../config/env.js'
import { logger } from '../utils/logger.js'

/**
 * Operational error — something the client did, or a known failure we expect.
 * Anything that is NOT an AppError is treated as a bug and never has its
 * message shown to the client.
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, message, 'bad_request', details)
export const unauthorized = (message = 'Authentication required.') =>
  new AppError(401, message, 'unauthorized')
export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError(403, message, 'forbidden')
export const notFound = (message = 'Not found.') =>
  new AppError(404, message, 'not_found')
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, message, 'conflict', details)
export const tooMany = (message = 'Too many requests.') =>
  new AppError(429, message, 'rate_limited')

/** 404 handler. Mounted after all routes, before the error handler. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(notFound(`Route ${req.method} ${req.originalUrl} does not exist.`))
}

/**
 * Terminal error handler.
 *
 * Express identifies this by its four-parameter signature, so `next` must stay
 * in the list even though it is unused.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // Express identifies the error handler by its four-parameter arity, so
  // `_next` must stay in the signature even though it is never called.
  _next: NextFunction
) {
  // Zod failures are always client errors; flatten them into field messages.
  if (error instanceof ZodError) {
    res.status(422).json({
      error: 'Validation failed.',
      code: 'validation_failed',
      fields: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
    return
  }

  if (error instanceof AppError) {
    // 4xx is routine; log at warn so it does not drown real failures.
    logger.warn(
      { err: error, path: req.originalUrl, status: error.status },
      'handled error'
    )
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    })
    return
  }

  // Anything else is a bug: log it in full, tell the client nothing.
  logger.error({ err: error, path: req.originalUrl }, 'unhandled error')
  res.status(500).json({
    error: 'Internal server error.',
    code: 'internal_error',
    ...(isProduction
      ? {}
      : { message: error instanceof Error ? error.message : String(error) }),
  })
}
