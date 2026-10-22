import { Router } from 'express'

import { checkDatabase } from '../db/index.js'

/**
 * Health endpoints.
 *
 * Two of them, because they answer different questions:
 *
 *  GET /health        liveness - "is the process up?" Touches no dependency,
 *                     so a database blip cannot make the supervisor kill a
 *                     perfectly healthy process.
 *
 *  GET /health/ready  readiness - "can it serve traffic?" Checks the database
 *                     and returns 503 when it cannot. This is the one the load
 *                     balancer and the deploy script should gate on.
 */
export const healthRouter: Router = Router()

const startedAt = Date.now()

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  })
})

healthRouter.get('/ready', async (_req, res) => {
  const database = await checkDatabase()

  const checks = {
    process: { ok: true },
    database,
    // PHASE 6: Redis check lands here when the audio queue needs it.
    redis: { ok: true, skipped: true as const },
  }

  const ok = database.ok
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks })
})
