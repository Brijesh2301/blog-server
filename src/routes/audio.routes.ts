import { Router } from 'express'
import { z } from 'zod'

import { requireAuth, requireRole } from '../middleware/auth.js'
import { body, params, validate } from '../middleware/validate.js'
import * as audio from '../services/audio.service.js'
import { slugParam, uuidParam } from '../validators/common.schema.js'

/**
 * Listen feature endpoints.
 *
 * The public one returns either a pre-generated MP3 URL or the plain text for
 * the browser to speak. The client does not need to know which tier it is on
 * until it has the payload, so the player is written once.
 */
export const audioRouter: Router = Router()

/** Public: what should this article sound like? */
audioRouter.get(
  '/posts/:slug/audio',
  validate({ params: slugParam }),
  async (req, res) => {
    const { slug } = params<{ slug: string }>(req)
    const payload = await audio.getSpeechPayload(slug)

    // The text is stable for as long as the post is, so let it be cached.
    res.set(
      'Cache-Control',
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
    )
    res.json(payload)
  }
)

/** Admin: request generation. Honest when the provider is not wired. */
audioRouter.post(
  '/admin/posts/:id/audio',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({
    params: uuidParam,
    body: z.object({
      force: z.boolean().optional(),
      voice: z.string().max(60).optional(),
    }),
  }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    const input = body<{ force?: boolean; voice?: string }>(req)
    res.json(await audio.generateAudioForPost(id, input))
  }
)

audioRouter.patch(
  '/admin/posts/:id/audio',
  requireAuth,
  requireRole('admin', 'editor'),
  validate({ params: uuidParam, body: z.object({ enabled: z.boolean() }) }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    const { enabled } = body<{ enabled: boolean }>(req)
    res.json(await audio.setAudioEnabled(id, enabled))
  }
)
