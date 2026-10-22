import type { NextFunction, Request, Response } from 'express'
import type { ZodType } from 'zod'

/**
 * Zod validation middleware.
 *
 * Parsed output lands on `req.valid`, never back onto `req.query` or
 * `req.params` — Express 5 made those getters, so assigning to them throws.
 *
 * Validation failures are thrown, not handled here, so the single error
 * handler owns the response shape for every route.
 */
export type ValidationTargets = {
  body?: ZodType
  query?: ZodType
  params?: ZodType
}

export function validate(targets: ValidationTargets) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.valid = {}
      if (targets.params) req.valid.params = targets.params.parse(req.params)
      if (targets.query) req.valid.query = targets.query.parse(req.query)
      if (targets.body) req.valid.body = targets.body.parse(req.body)
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Typed accessors, so routes do not cast at every call site. */
export const body = <T>(req: Request): T => req.valid.body as T
export const query = <T>(req: Request): T => req.valid.query as T
export const params = <T>(req: Request): T => req.valid.params as T
