import type { Request } from 'express'

/**
 * Typed cookie accessor.
 *
 * cookie-parser types `req.cookies` as `any`, so every direct read of it is an
 * unchecked value flowing straight into auth code — the one place that should
 * be least tolerant of `any`. This narrows it once, here, so callers get
 * `string | undefined` and the rest of the codebase stays free of unsafe
 * member access.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const jar: unknown = req.cookies
  if (typeof jar !== 'object' || jar === null) return undefined

  const value: unknown = (jar as Record<string, unknown>)[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
