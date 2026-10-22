import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { desc, eq } from 'drizzle-orm'
import sharp from 'sharp'

import { env } from '../config/env.js'
import { db } from '../db/index.js'
import { media } from '../db/schema.js'
import { badRequest, notFound } from '../middleware/error.js'
import { logger } from '../utils/logger.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * MEDIA
 * ═════════════════════════════════════════════════════════════════════════════
 * Every uploaded image is converted to WebP. Not offered as an option —
 * converted, always, before anything is written to disk.
 *
 * WHY CONVERT AT UPLOAD RATHER THAN LEAVE IT TO next/image
 * next/image already negotiates AVIF and WebP per request, so this is not
 * about what the browser receives. It is about what we STORE:
 *
 *  - A 4 MB phone JPEG becomes roughly 300 KB. Storage, backups and CDN
 *    egress are all paid on the stored bytes.
 *  - The optimiser's own work shrinks with its input. Re-encoding a 4000px
 *    original on every cache miss is slow and, on a managed platform, billed.
 *  - Re-encoding STRIPS EXIF. A photo straight off a phone carries GPS
 *    coordinates, and publishing an author's home address because nobody
 *    thought about metadata is a real incident, not a hypothetical one.
 *
 * WHY A DIMENSION CAP
 * Nothing on this site is displayed above 1920px, and an un-resized 6000px
 * upload is pure cost: slower optimisation, a bigger original, zero visible
 * difference. The cap is applied with `withoutEnlargement`, so a small logo is
 * never upscaled into a blurry mess.
 *
 * STORAGE IS BEHIND AN INTERFACE
 * Local disk is the default so the feature works with no third-party account.
 * `provider` is recorded per row, so a later Cloudinary or S3 backend can be
 * added without migrating what already exists.
 */

/** Nothing on the site renders wider than this. */
const MAX_DIMENSION = 1920

/** Visually lossless for photographs, and roughly a third of JPEG's size. */
const WEBP_QUALITY = 82

/** Media-library thumbnail. Small enough that a grid of 60 is still fast. */
const THUMB_WIDTH = 400

/**
 * What we are willing to decode.
 *
 * An allowlist, and deliberately without SVG: an SVG is a document that can
 * carry script, and sharp would happily rasterise one while the original file
 * sat on disk waiting to be served. The Next config also refuses remote SVGs.
 */
const ACCEPTED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
])

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/** Where files land. Served by Express at `/uploads`. */
const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads')

export type UploadResult = {
  id: string
  url: string
  thumbUrl: string
  width: number
  height: number
  format: string
  bytes: number
  alt: string | null
}

function publicUrl(filename: string): string {
  // Absolute, because the admin and the public site may be on other origins
  // and a relative path would resolve against whichever one rendered it.
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/uploads/${filename}`
}

/**
 * Converts an uploaded buffer to WebP and records it.
 *
 * Throws `badRequest` rather than 500 for anything the uploader can fix — a
 * wrong file type or a corrupt image is a user error, and a 500 tells them
 * nothing actionable.
 */
export async function uploadImage(input: {
  buffer: Buffer
  mimetype: string
  originalName: string
  alt?: string
  uploadedBy?: string
}): Promise<UploadResult> {
  if (!ACCEPTED.has(input.mimetype)) {
    throw badRequest(
      `Unsupported image type "${input.mimetype}". Use JPEG, PNG, WebP, AVIF, GIF or TIFF.`
    )
  }

  if (input.buffer.length > MAX_UPLOAD_BYTES) {
    throw badRequest(`Images must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`)
  }

  /*
   * `failOn: 'none'` so a slightly malformed but decodable file still works —
   * phone cameras and older editors produce these constantly, and refusing
   * them is a support burden for no security gain. The metadata read below is
   * what actually validates that it is an image at all.
   */
  const image = sharp(input.buffer, { failOn: 'none' })

  let meta: sharp.Metadata
  try {
    meta = await image.metadata()
  } catch {
    throw badRequest('That file could not be read as an image.')
  }

  if (!meta.width || !meta.height) {
    throw badRequest('That file could not be read as an image.')
  }

  const base = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  await mkdir(UPLOAD_ROOT, { recursive: true })

  /*
   * `rotate()` with no argument applies the EXIF orientation and then drops
   * it. Without it, a portrait photo from a phone is stored sideways: the
   * pixels are landscape and only the orientation tag made it look right, and
   * that tag does not survive the re-encode.
   */
  const pipeline = image
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  const filename = `${base}.webp`
  await writeFile(path.join(UPLOAD_ROOT, filename), data)

  // A separate small file for the library grid. Loading sixty 1920px images
  // to render thumbnails is the kind of thing that makes an admin feel slow.
  const thumbName = `${base}-thumb.webp`
  await writeFile(
    path.join(UPLOAD_ROOT, thumbName),
    await sharp(data)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer()
  )

  const [row] = await db
    .insert(media)
    .values({
      url: publicUrl(filename),
      providerId: base,
      provider: 'local',
      width: info.width,
      height: info.height,
      format: 'webp',
      bytes: info.size,
      alt: input.alt?.trim() || null,
      uploadedBy: input.uploadedBy ?? null,
    })
    .returning()

  if (!row) throw badRequest('Could not record the upload.')

  logger.info(
    {
      id: row.id,
      from: `${meta.format} ${meta.width}x${meta.height} ${input.buffer.length}B`,
      to: `webp ${info.width}x${info.height} ${info.size}B`,
      saved: `${Math.round((1 - info.size / input.buffer.length) * 100)}%`,
    },
    'image converted to webp'
  )

  return {
    id: row.id,
    url: row.url,
    thumbUrl: publicUrl(thumbName),
    width: row.width,
    height: row.height,
    format: 'webp',
    bytes: row.bytes ?? info.size,
    alt: row.alt,
  }
}

/** The media library, newest first. */
export async function listMedia(limit = 60, offset = 0) {
  const rows = await db
    .select()
    .from(media)
    .orderBy(desc(media.createdAt))
    .limit(Math.min(limit, 200))
    .offset(offset)

  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    thumbUrl: row.providerId ? publicUrl(`${row.providerId}-thumb.webp`) : row.url,
    width: row.width,
    height: row.height,
    format: row.format,
    bytes: row.bytes,
    alt: row.alt,
    createdAt: row.createdAt,
  }))
}

/** Alt text and caption are editable after the fact; the pixels are not. */
export async function updateMedia(
  id: string,
  patch: { alt?: string; caption?: string; credit?: string }
) {
  const [updated] = await db
    .update(media)
    .set({
      ...(patch.alt !== undefined ? { alt: patch.alt.trim() || null } : {}),
      ...(patch.caption !== undefined ? { caption: patch.caption.trim() || null } : {}),
      ...(patch.credit !== undefined ? { credit: patch.credit.trim() || null } : {}),
    })
    .where(eq(media.id, id))
    .returning()

  if (!updated) throw notFound('Media not found.')
  return updated
}

/**
 * Deletes the row and the files.
 *
 * The ROW goes first. If the unlink fails — a permissions problem, a file
 * already gone — the record is still removed and the admin stops showing a
 * broken thumbnail. An orphaned file on disk is a housekeeping problem; a row
 * pointing at a missing file is a broken page.
 *
 * `posts.coverImageId` is `ON DELETE SET NULL`, so deleting an image in use
 * clears the reference rather than cascading into the post.
 */
export async function deleteMedia(id: string): Promise<void> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1)
  if (!row) throw notFound('Media not found.')

  await db.delete(media).where(eq(media.id, id))

  if (row.provider === 'local' && row.providerId) {
    for (const name of [`${row.providerId}.webp`, `${row.providerId}-thumb.webp`]) {
      try {
        await unlink(path.join(UPLOAD_ROOT, name))
      } catch (error) {
        logger.warn({ err: error, name }, 'could not remove media file')
      }
    }
  }
}

export { UPLOAD_ROOT }
