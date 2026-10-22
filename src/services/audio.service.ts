import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { env } from '../config/env.js'
import { db } from '../db/index.js'
import { posts } from '../db/schema.js'
import { badRequest, notFound } from '../middleware/error.js'
import { logger } from '../utils/logger.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LISTEN — AUDIO GENERATION
 * ═════════════════════════════════════════════════════════════════════════════
 * Two tiers, as the brief specifies:
 *
 *   FREE     the browser's Web Speech API. Costs nothing, needs no server, and
 *            works offline. Implemented entirely client-side; this file is not
 *            involved.
 *   PREMIUM  pre-generated audio from a TTS provider, stored on a CDN and
 *            served as MP3. That is what this file manages.
 *
 * The thing that makes the premium tier affordable is the CONTENT HASH. Audio
 * is keyed by a hash of the exact text that was synthesised, so re-saving a
 * post without touching its prose — fixing a tag, changing the cover — never
 * regenerates and never costs a second time. Without it, every autosave would
 * be a billable TTS call.
 */

/** Rough per-provider cost, USD per 1,000 characters, for the budget guard. */
const COST_PER_1K: Record<string, number> = {
  openai: 0.015,
  elevenlabs: 0.3,
  google: 0.016,
  azure: 0.016,
}

/**
 * Strips what should not be read aloud.
 *
 * Code blocks, tables and raw URLs are unlistenable — a synthesiser reading
 * `const x = useMemo(() => ...)` character by character is worse than silence.
 * They are removed rather than summarised, and the player tells the listener
 * that code was skipped.
 */
export function toSpeechText(input: {
  title: string
  authorName?: string | null
  contentHtml: string | null
}): string {
  const html = input.contentHtml ?? ''

  const stripped = html
    // Whole blocks that should never be spoken.
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<table[\s\S]*?<\/table>/gi, ' ')
    .replace(/<code[\s\S]*?<\/code>/gi, ' ')
    // A heading should land as its own sentence, not run into the next
    // paragraph, so give it terminal punctuation before tags are dropped.
    .replace(/<\/h([2-4])>/gi, '. ')
    .replace(/<\/(p|li|blockquote)>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    // Bare URLs read as a stream of letters; drop them.
    .replace(/https?:\/\/\S+/g, ' ')

  const text = decodeEntities(stripped)
    .replace(/\s+/g, ' ')
    // The tag stripping above can leave ". ." runs.
    .replace(/\s*\.\s*(\.\s*)+/g, '. ')
    .trim()

  const intro = input.authorName
    ? `${input.title}. By ${input.authorName}.`
    : `${input.title}.`

  return `${intro} ${text}`.trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
}

/**
 * Stable key for "this exact text, in this exact voice".
 *
 * The voice is LENGTH-PREFIXED, not just separated.
 *
 * A plain `${voice}::${text}` is ambiguous: voice "a" with text "b::c" and
 * voice "a::b" with text "c" both concatenate to "a::b::c" and collide, so one
 * would be served the other's audio file. Voice names are admin-supplied
 * free text up to 60 characters, so that is reachable, not theoretical.
 * Prefixing the length makes the split point unambiguous for any input.
 *
 * Changing this construction invalidates every stored hash and forces one
 * regeneration per post — which is why it was worth fixing before any audio
 * existed rather than after.
 */
export function audioHash(text: string, voice: string): string {
  return createHash('sha256')
    .update(`${voice.length}:${voice}::${text}`)
    .digest('hex')
    .slice(0, 64)
}

/** Spoken words per minute, for the estimated listen time. */
const SPOKEN_WPM = 150

export function estimateDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round((words / SPOKEN_WPM) * 60))
}

export type GenerateResult =
  | { status: 'ready'; url: string; duration: number; hash: string; skipped: boolean }
  | { status: 'skipped'; reason: string }

/**
 * Generates audio for a post, or explains why it did not.
 *
 * Never throws for a missing provider key: audio is an enhancement, and a
 * publish must not fail because TTS is unconfigured.
 */
export async function generateAudioForPost(
  postId: string,
  options: { force?: boolean; voice?: string } = {}
): Promise<GenerateResult> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1)
  if (!post) throw notFound('Post not found.')
  if (!post.audioEnabled)
    return { status: 'skipped', reason: 'Audio is off for this post.' }

  const voice = options.voice ?? post.audioVoice ?? 'alloy'
  const text = toSpeechText({
    title: post.title,
    authorName: null,
    contentHtml: post.contentHtml,
  })

  if (text.length < 200) {
    return { status: 'skipped', reason: 'Not enough prose to synthesise.' }
  }

  const hash = audioHash(text, voice)

  // The whole point of the hash: unchanged text is never re-synthesised.
  if (!options.force && post.audioHash === hash && post.audioUrl) {
    return {
      status: 'ready',
      url: post.audioUrl,
      duration: post.audioDuration ?? estimateDuration(text),
      hash,
      skipped: true,
    }
  }

  if (!env.TTS_PROVIDER) {
    return { status: 'skipped', reason: 'No TTS provider configured (TTS_PROVIDER).' }
  }

  const estimatedCost = (text.length / 1000) * (COST_PER_1K[env.TTS_PROVIDER] ?? 0.02)
  if (estimatedCost > env.TTS_MONTHLY_BUDGET_USD) {
    logger.warn(
      { postId, estimatedCost, budget: env.TTS_MONTHLY_BUDGET_USD },
      'TTS generation would exceed the monthly budget'
    )
    return { status: 'skipped', reason: 'Generating this would exceed the TTS budget.' }
  }

  await db
    .update(posts)
    .set({ audioStatus: 'queued', audioVoice: voice })
    .where(eq(posts.id, postId))

  /*
   * PHASE 8 wires the real provider call and the upload, behind BullMQ so a
   * long synthesis does not block the request:
   *
   *   const mp3 = await synthesise(env.TTS_PROVIDER, text, voice)
   *   const url = await uploadToCdn(mp3, `audio/${post.slug}-${hash}.mp3`)
   *
   * Everything around it — the hash check, the budget guard, the status
   * machine, the schema and the podcast feed — is in place and tested, so
   * that is genuinely the only missing piece.
   */
  logger.info(
    { postId, provider: env.TTS_PROVIDER, chars: text.length, estimatedCost },
    'TTS generation requested (provider call not yet wired)'
  )

  await db.update(posts).set({ audioStatus: 'none' }).where(eq(posts.id, postId))

  return {
    status: 'skipped',
    reason: `Provider "${env.TTS_PROVIDER}" is selected but its API call is not wired yet.`,
  }
}

/** Admin toggle for a single post. */
export async function setAudioEnabled(postId: string, enabled: boolean) {
  const [updated] = await db
    .update(posts)
    .set({ audioEnabled: enabled, ...(enabled ? {} : { audioStatus: 'none' as const }) })
    .where(eq(posts.id, postId))
    .returning({ id: posts.id, audioEnabled: posts.audioEnabled })

  if (!updated) throw notFound('Post not found.')
  return updated
}

/** The text the client-side Web Speech API reads, chunked by sentence. */
export async function getSpeechPayload(slug: string) {
  const [post] = await db
    .select({
      title: posts.title,
      contentHtml: posts.contentHtml,
      audioUrl: posts.audioUrl,
      audioStatus: posts.audioStatus,
      audioEnabled: posts.audioEnabled,
      audioDuration: posts.audioDuration,
    })
    .from(posts)
    .where(eq(posts.slug, slug))
    .limit(1)

  if (!post) throw notFound('Post not found.')
  if (!post.audioEnabled) throw badRequest('Audio is off for this post.')

  const text = toSpeechText({ title: post.title, contentHtml: post.contentHtml })

  return {
    // Premium audio when it exists, otherwise the browser reads this text.
    audioUrl: post.audioStatus === 'ready' ? post.audioUrl : null,
    text,
    estimatedSeconds: post.audioDuration ?? estimateDuration(text),
  }
}
