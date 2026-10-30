import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'

import { desc, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { deleteByPublicId, uploadBuffer } from '../lib/cloudinary.js'
import { env } from '../config/env.js'
import { db } from '../db/index.js'
import { media } from '../db/schema.js'
import { badRequest, notFound } from '../middleware/error.js'
import { logger } from '../utils/logger.js'

/**
 * MEDIA
 * Every uploaded image is converted to WebP (EXIF stripped, capped at 1920px)
 * and stored on Cloudinary. Render's disk is ephemeral, so nothing is kept
 * locally. Rows with provider 'local' are legacy and still handled on delete.
 */

/** Nothing on the site renders wider than this. */
const MAX_DIMENSION = 1920

/** Visually lossless for photographs, and roughly a third of JPEG's size. */
const WEBP_QUALITY = 82

/** Media-library thumbnail width, applied as a Cloudinary transformation. */
const THUMB_WIDTH = 400

/** Allowlist, deliberately without SVG (an SVG can carry script). */
const ACCEPTED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
])

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/** Legacy local folder. Still exported because app.ts serves `/uploads` from it. */
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

/** Legacy URL for files stored on local disk. */
function publicUrl(filename: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/uploads/${filename}`
}

/** Cloudinary resizes on the fly: insert a transformation after /upload/. */
function thumbUrlFor(url: string): string {
  return url.includes('/upload/')
    ? url.replace('/upload/', `/upload/w_${THUMB_WIDTH},c_limit,f_webp,q_70/`)
    : url
}

/**
 * Converts an uploaded buffer to WebP, uploads it to Cloudinary and records it.
 * Throws `badRequest` for anything the uploader can fix.
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

  // rotate() applies the EXIF orientation and then drops it.
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

  // Upload the converted WebP to Cloudinary (public id: blog/<base>)
  const { url } = await uploadBuffer(data, base)

  const [row] = await db
    .insert(media)
    .values({
      url,
      providerId: base,
      provider: 'cloudinary',
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
    thumbUrl: thumbUrlFor(row.url),
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
    thumbUrl:
      row.provider === 'local' && row.providerId
        ? publicUrl(`${row.providerId}-thumb.webp`)
        : thumbUrlFor(row.url),
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
 * Deletes the row first, then the stored file. A leftover file is housekeeping;
 * a row pointing at a missing file is a broken page.
 */
export async function deleteMedia(id: string): Promise<void> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1)
  if (!row) throw notFound('Media not found.')

  await db.delete(media).where(eq(media.id, id))

  if (!row.providerId) return

  if (row.provider === 'cloudinary') {
    try {
      await deleteByPublicId(`blog/${row.providerId}`)
    } catch (error) {
      logger.warn({ err: error, id }, 'could not remove cloudinary image')
    }
    return
  }

  if (row.provider === 'local') {
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