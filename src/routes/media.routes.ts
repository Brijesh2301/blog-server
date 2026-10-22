import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'

import { requireAuth, requireRole } from '../middleware/auth.js'
import { badRequest } from '../middleware/error.js'
import { body, params, query, validate } from '../middleware/validate.js'
import * as mediaService from '../services/media.service.js'
import { uuidParam } from '../validators/common.schema.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * MEDIA — upload, library, delete
 * ═════════════════════════════════════════════════════════════════════════════
 * Every route here is staff-only. There is no public upload endpoint, and
 * there should not be: an open image upload is a free CDN for whoever finds
 * it, and a malware host shortly after.
 */
export const mediaRouter: Router = Router()

/**
 * Memory storage, not disk.
 *
 * The file is converted to WebP before anything is written, so a disk-backed
 * multer would write the untouched original, we would re-read it, convert it,
 * and then have to clean it up — with the original (EXIF and all) briefly
 * sitting in a temp directory. Keeping it in memory means the raw upload never
 * touches the filesystem.
 *
 * The size limit is enforced HERE as well as in the service. multer rejects at
 * the stream level, so an oversized upload stops mid-transfer rather than
 * being buffered in full and then refused.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: mediaService.MAX_UPLOAD_BYTES,
    files: 1,
    // Without this, a crafted multipart body with thousands of fields is a
    // cheap memory-exhaustion vector.
    fields: 10,
  },
})

/** Upload one image. Converted to WebP server-side, always. */
mediaRouter.post(
  '/admin/media',
  requireAuth,
  requireRole('admin', 'editor', 'author'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) throw badRequest('No file was uploaded.')

    const alt = readTextField(req.body, 'alt')

    res.status(201).json({
      media: await mediaService.uploadImage({
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        originalName: req.file.originalname,
        alt,
        uploadedBy: req.user!.sub,
      }),
    })
  }
)

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
})

mediaRouter.get(
  '/admin/media',
  requireAuth,
  requireRole('admin', 'editor', 'author'),
  validate({ query: listQuery }),
  async (req, res) => {
    const { limit, offset } = query<z.infer<typeof listQuery>>(req)
    res.json({ media: await mediaService.listMedia(limit, offset) })
  }
)

const patchBody = z.object({
  alt: z.string().trim().max(300).optional(),
  caption: z.string().trim().max(500).optional(),
  credit: z.string().trim().max(200).optional(),
})

mediaRouter.patch(
  '/admin/media/:id',
  requireAuth,
  requireRole('admin', 'editor', 'author'),
  validate({ params: uuidParam, body: patchBody }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    res.json({
      media: await mediaService.updateMedia(id, body<z.infer<typeof patchBody>>(req)),
    })
  }
)

mediaRouter.delete(
  '/admin/media/:id',
  requireAuth,
  // Deletion is admin/editor only. An author deleting an image another
  // author's published post depends on is not a recoverable mistake.
  requireRole('admin', 'editor'),
  validate({ params: uuidParam }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req)
    await mediaService.deleteMedia(id)
    res.status(204).end()
  }
)

/**
 * Reads one text field from a multipart body.
 *
 * multer types `req.body` as `any` — it cannot know the shape of a multipart
 * form — and letting that `any` flow into the service would silently defeat
 * every type guarantee downstream. Narrowing it here, once, keeps the unsafe
 * access in a single place where it is checked properly.
 */
function readTextField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}
