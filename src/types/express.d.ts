import type { AccessTokenPayload } from '../lib/jwt.js'

/**
 * Request augmentation.
 *
 * Validated input is attached to `req.valid` rather than overwriting
 * `req.query` / `req.params`, because Express 5 made those getters — assigning
 * to them throws. Keeping them separate is also clearer: `req.valid.query` is
 * parsed and typed, `req.query` is whatever the client sent.
 */
declare global {
  namespace Express {
    interface Request {
      valid: {
        body?: unknown
        query?: unknown
        params?: unknown
      }
      /** Set by requireAuth / optionalAuth. */
      user?: AccessTokenPayload
    }
  }
}

export {}
