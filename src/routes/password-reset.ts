import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'

import { db } from '../db/index.js'
import { passwordResetTokens, users } from '../db/schema.js'

const router = Router()
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

async function sendResetEmail(to: string, link: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM ?? 'onboarding@resend.dev',
      to,
      subject: 'Reset your admin password',
      html: `<p>Click to reset your password (valid for 30 minutes):</p>
             <p><a href="${link}">${link}</a></p>
             <p>If you didn't request this, ignore this email.</p>`,
    }),
  })
  if (!res.ok) console.error('Resend failed', res.status, await res.text())
}

router.post('/forgot-password', async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body)
  // Same response whatever happens, so emails can't be enumerated.
  const generic = { message: 'If that email exists, a reset link has been sent.' }
  if (!parsed.success) return res.json(generic)

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email.toLowerCase()))
    .limit(1)

  if (user) {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id))
    const token = randomBytes(32).toString('hex')
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    })
    const link = `${process.env.CLIENT_URL}/en/reset-password?token=${token}`
    await sendResetEmail(user.email, link)
  }
  return res.json(generic)
})

router.post('/reset-password', async (req, res) => {
  const parsed = z
    .object({ token: z.string().min(32), password: z.string().min(10).max(128) })
    .safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'Password must be at least 10 characters.' })
  }

  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, sha256(parsed.data.token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    )
    .limit(1)

  if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired.' })

  const passwordHash = await bcrypt.hash(parsed.data.password, 12)
  await db.update(users).set({ passwordHash }).where(eq(users.id, row.userId))
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, row.id))
  // If you store refresh tokens/sessions, delete this user's here to sign out other devices.

  return res.json({ message: 'Password updated. You can now sign in.' })
})

export default router