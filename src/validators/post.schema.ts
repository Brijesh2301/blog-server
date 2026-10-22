import { z } from 'zod'

import { paginationQuery } from './common.schema.js'

/**
 * Post validation.
 *
 * The SEO field limits are not arbitrary — they are the budgets Google renders
 * before truncating, so exceeding them means the tail of the title or
 * description never appears in a result. The editor's live SERP preview in
 * Phase 4 uses the same numbers.
 */

export const META_TITLE_MAX = 70
export const META_DESCRIPTION_MAX = 160
export const META_DESCRIPTION_MIN = 140

const slug = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug may contain lowercase letters, numbers and single hyphens only.'
  )

const faqItem = z.object({
  question: z.string().trim().min(5).max(300),
  answer: z.string().trim().min(10).max(2000),
})

/** The languages the site publishes in. Mirrors client/src/i18n/config.ts. */
export const postLocale = z.enum(['en', 'hi'])

export const postStatus = z.enum([
  'draft',
  'in_review',
  'scheduled',
  'published',
  'archived',
])

const basePost = z.object({
  title: z.string().trim().min(3, 'Give the post a title.').max(200),
  subtitle: z.string().trim().max(300).optional(),
  /** Omit to derive from the title; supply to override. */
  slug: slug.optional(),
  excerpt: z.string().trim().max(500).optional(),

  /** TipTap document. Shape is validated by the editor, not here. */
  content: z.unknown().optional(),
  contentHtml: z.string().max(1_000_000).optional(),
  contentText: z.string().max(1_000_000).optional(),

  coverImageId: z.uuid().optional(),
  coverImageUrl: z.url().max(1000).optional(),
  coverImageAlt: z.string().trim().max(300).optional(),

  /**
   * Deliberately NOT `.default('draft')`.
   *
   * `.partial()` does not strip a `.default()` — it only makes the key
   * optional — so a default here would be injected into every PATCH body that
   * omitted `status`, silently unpublishing a live post on an unrelated edit.
   * The default is applied in `createPostSchema` instead, where it belongs.
   */
  status: postStatus.optional(),
  categoryId: z.uuid().optional(),
  seriesId: z.uuid().optional(),
  seriesPosition: z.number().int().min(0).max(999).optional(),
  tagIds: z.array(z.uuid()).max(12, 'A post may carry at most 12 tags.').optional(),

  // ── SEO ─────────────────────────────────────────────────────────────────
  metaTitle: z.string().trim().max(META_TITLE_MAX).optional(),
  metaDescription: z.string().trim().max(META_DESCRIPTION_MAX).optional(),
  canonicalUrl: z.url().max(1000).optional(),
  ogImage: z.url().max(1000).optional(),
  focusKeyword: z.string().trim().max(120).optional(),
  secondaryKeywords: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  noIndex: z.boolean().optional(),

  faq: z.array(faqItem).max(20).optional(),

  /**
   * The language this post is written in.
   *
   * Deliberately NOT `.default('en')` on the base object — `.partial()` does
   * not strip defaults, so a default here would be injected into every PATCH
   * and silently relabel a Hindi article as English. The default belongs in
   * `createPostSchema`, exactly as `status` does.
   */
  locale: postLocale.optional(),

  /** The post this one translates. Must be in a different language. */
  translationOfId: z.uuid().nullable().optional(),

  // ── Audio (Phase 6 generates; the toggle lives here from Phase 2) ───────
  audioEnabled: z.boolean().optional(),
  audioVoice: z.string().trim().max(60).optional(),

  featured: z.boolean().optional(),
  editorsPick: z.boolean().optional(),
  allowComments: z.boolean().optional(),

  publishedAt: z.iso.datetime({ offset: true }).optional(),
  scheduledFor: z.iso.datetime({ offset: true }).optional(),
})

/**
 * Publishing has stricter requirements than saving a draft.
 *
 * This is the editorial checklist from the brief, enforced by the API rather
 * than only by the admin UI — otherwise a direct API call could publish a post
 * that the UI would have blocked.
 */
export const createPostSchema = basePost
  .extend({ status: postStatus.default('draft'), locale: postLocale.default('en') })
  .superRefine((data, ctx) => {
    if (data.status !== 'published' && data.status !== 'scheduled') return

    const require = (condition: boolean, path: string, message: string) => {
      if (!condition) {
        ctx.addIssue({ code: 'custom', path: [path], message })
      }
    }

    require(Boolean(
      data.excerpt && data.excerpt.length >= 50
    ), 'excerpt', 'An excerpt of at least 50 characters is required before publishing.')
    require(Boolean(
      data.coverImageUrl
    ), 'coverImageUrl', 'A cover image is required before publishing.')
    // Alt text is an accessibility requirement and an image-SEO signal; a cover
    // image without it must not reach the public site.
    require(Boolean(
      data.coverImageAlt && data.coverImageAlt.trim().length >= 10
    ), 'coverImageAlt', 'Cover image alt text is required before publishing.')
    require(Boolean(
      data.categoryId
    ), 'categoryId', 'A category is required before publishing.')
    require(Boolean(
      data.focusKeyword
    ), 'focusKeyword', 'A focus keyword is required before publishing.')
    require(Boolean(
      data.metaDescription && data.metaDescription.length >= META_DESCRIPTION_MIN
    ), 'metaDescription', `A meta description of ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX} characters is required before publishing.`)

    if (data.status === 'scheduled') {
      require(Boolean(
        data.scheduledFor
      ), 'scheduledFor', 'A scheduled post needs a publish time.')
      if (data.scheduledFor && new Date(data.scheduledFor) <= new Date()) {
        ctx.addIssue({
          code: 'custom',
          path: ['scheduledFor'],
          message: 'The scheduled time must be in the future.',
        })
      }
    }
  })

/**
 * Every field optional and NO defaults, so a PATCH only ever changes the keys
 * the caller actually sent. The publish checklist is re-run in the service
 * layer against the merged row.
 */
export const updatePostSchema = basePost.partial()

export const listPostsQuery = paginationQuery.extend({
  status: postStatus.optional(),
  /**
   * Which language to list.
   *
   * Optional so the ADMIN can see every post at once, but every public
   * listing passes it. Without it the Hindi blog shows English articles.
   */
  locale: postLocale.optional(),
  category: z.string().trim().max(140).optional(),
  tag: z.string().trim().max(100).optional(),
  author: z.string().trim().max(120).optional(),
  series: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(),
  featured: z.coerce.boolean().optional(),
  editorsPick: z.coerce.boolean().optional(),
  sort: z.enum(['newest', 'oldest', 'popular', 'relevance']).default('newest'),
})

export type CreatePostInput = z.infer<typeof createPostSchema>
export type UpdatePostInput = z.infer<typeof updatePostSchema>
export type ListPostsQuery = z.infer<typeof listPostsQuery>
