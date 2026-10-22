import { Router } from 'express'

import { readCookie } from '../lib/cookies.js'
import { REFRESH_COOKIE, requireAuth } from '../middleware/auth.js'
import { unauthorized } from '../middleware/error.js'
import { authLimiter } from '../middleware/rate-limit.js'
import { body, validate } from '../middleware/validate.js'
import * as auth from '../services/auth.service.js'
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '../validators/auth.schema.js'

/**
 * Auth routes.
 *
 * Tokens are returned ONLY as httpOnly cookies, never in the JSON body. A
 * token in the response body ends up in localStorage, which is readable by
 * any injected script; an httpOnly cookie is not.
 *
 * Express 5 forwards rejected promises to the error handler automatically, so
 * these handlers need no try/catch or asyncHandler wrapper.
 */
export const authRouter: Router = Router()

authRouter.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  async (req, res) => {
    const input = body<RegisterInput>(req)
    const result = await auth.register({
      ...input,
      userAgent: req.get('user-agent') ?? undefined,
      ip: req.ip,
    })
    auth.setAuthCookies(res, result.access, result.refresh)
    res.status(201).json({ user: result.user })
  }
)

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  async (req, res) => {
    const input = body<LoginInput>(req)
    const result = await auth.login({
      ...input,
      userAgent: req.get('user-agent') ?? undefined,
      ip: req.ip,
    })
    auth.setAuthCookies(res, result.access, result.refresh)
    res.json({ user: result.user })
  }
)

authRouter.post('/refresh', async (req, res) => {
  const token = readCookie(req, REFRESH_COOKIE)
  if (!token) throw unauthorized('Session expired. Please sign in again.')

  const result = await auth.refresh({
    token,
    userAgent: req.get('user-agent') ?? undefined,
    ip: req.ip,
  })
  auth.setAuthCookies(res, result.access, result.refresh)
  res.json({ user: result.user })
})

authRouter.post('/logout', async (req, res) => {
  await auth.logout(readCookie(req, REFRESH_COOKIE))
  auth.clearAuthCookies(res)
  res.status(204).end()
})

/** Signs out every device. Used after a password change or a theft scare. */
authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await auth.revokeAllForUser(req.user!.sub)
  auth.clearAuthCookies(res)
  res.status(204).end()
})

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await auth.getCurrentUser(req.user!.sub)
  if (!user) throw unauthorized('Your session is no longer valid.')
  res.json({ user })
})

authRouter.get('/sessions', requireAuth, async (req, res) => {
  res.json({ sessions: await auth.listActiveSessions(req.user!.sub) })
})
