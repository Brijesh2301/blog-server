import { Router } from 'express'
import { z } from 'zod'

import { requireAuth, requireRole } from '../middleware/auth.js'
import { notFound } from '../middleware/error.js'
import { body, query, validate } from '../middleware/validate.js'
import * as redirectService from '../services/redirect.service.js'

/**
 * Redirect manager.
 *
 * `GET /resolve` is the hot path: the frontend 404 handler calls it before
 * rendering a not-found page, so a moved URL answers 301 instead of 404. It is
 * public because it only ever reveals mappings that are already public.
 */
export const redirectsRouter: Router = Router()

redirectsRouter.get(
  '/resolve',
  validate({ query: z.object({ path: z.string().min(1).max(400) }) }),
  async (req, res) => {
    const { path } = query<{ path: string }>(req)
    const hit = await redirectService.resolveRedirect(path)
    if (!hit) throw notFound('No redirect for that path.')
    res.json(hit)
  }
)

/**
 * Public bulk table, consumed by the frontend proxy.
 *
 * Public on purpose: every row maps one already-public URL to another
 * already-public URL, so it reveals nothing that visiting the old URL would
 * not. Serving it in bulk lets the proxy cache the table and resolve redirects
 * at the edge with no per-request API call.
 *
 * Cached for a minute at the CDN; a redirect that is 60s stale still resolves
 * correctly, it merely may not include one added seconds ago.
 */
redirectsRouter.get('/resolve-all', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300')
  res.json({ redirects: await redirectService.listRedirects() })
})

/** Same data, for the admin UI. Kept authenticated for consistency. */
redirectsRouter.get(
  '/',
  requireAuth,
  requireRole('admin', 'editor'),
  async (_req, res) => {
    res.json({ redirects: await redirectService.listRedirects() })
  }
)

const createInput = z.object({
  from: z.string().min(1).max(400),
  to: z.string().min(1).max(400),
  statusCode: z
    .union([
      z.literal(301),
      z.literal(302),
      z.literal(307),
      z.literal(308),
      z.literal(410),
    ])
    .optional(),
})

redirectsRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ body: createInput }),
  async (req, res) => {
    const input = body<z.infer<typeof createInput>>(req)
    await redirectService.recordMove({ ...input, reason: 'manual' })
    res.status(201).json({ ok: true })
  }
)

redirectsRouter.delete(
  '/',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ query: z.object({ from: z.string().min(1).max(400) }) }),
  async (req, res) => {
    const { from } = query<{ from: string }>(req)
    const removed = await redirectService.deleteRedirect(from)
    if (!removed) throw notFound('No redirect for that path.')
    res.status(204).end()
  }
)
