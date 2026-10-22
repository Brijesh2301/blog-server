import { z } from 'zod'

/**
 * Shared primitives. Every route composes from these so that, for example,
 * "page" means the same thing and has the same ceiling everywhere.
 */

export const uuidParam = z.object({
  id: z.uuid('Must be a valid UUID.'),
})

export const slugParam = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug may contain lowercase letters, numbers and single hyphens only.'
    ),
})

/**
 * Pagination.
 *
 * `limit` is capped at 100: an uncapped limit is a denial-of-service vector,
 * because one request can ask the database to serialise the whole table.
 */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(12),
})

export type Pagination = z.infer<typeof paginationQuery>

export const sortOrder = z.enum(['asc', 'desc']).default('desc')

/** Trims, and turns an empty string into undefined so `.optional()` works. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional()

/** Standard envelope so every list endpoint paginates identically. */
export function paginated<T>(items: T[], total: number, { page, limit }: Pagination) {
  const totalPages = Math.max(1, Math.ceil(total / limit))
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  }
}
