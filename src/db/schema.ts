import { type SQL, relations, sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * DEVLUME SCHEMA — PostgreSQL 16
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Every index here exists for a query the application actually runs; the SEO
 * plan drives most of them:
 *
 *  - unique `slug` everywhere a URL is derived from a row, so a duplicate URL
 *    is impossible at the database level rather than by convention;
 *  - `(status, published_at DESC)` and `(category_id, status, published_at DESC)`
 *    because every listing, feed and sitemap page is that exact query;
 *  - a generated `tsvector` with weighted fields plus a GIN index, so search
 *    needs no second datastore (the Meilisearch/Algolia swap stays an
 *    interface change, not a schema change);
 *  - `redirects.from_path` unique, which is what makes slug-change 301s
 *    automatic and collision-free.
 *
 * Conventions:
 *  - `timestamp with time zone` everywhere. A publishing schedule that spans
 *    time zones is unworkable with naive timestamps.
 *  - `citext` for email so uniqueness is case-insensitive at the storage layer
 *    rather than depending on every caller lower-casing first.
 *  - snake_case column names, camelCase TS fields; drizzle maps them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Custom column types
// ─────────────────────────────────────────────────────────────────────────────

/** Case-insensitive text. Requires the `citext` extension (see migration 0000). */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
})

/** Postgres full-text search vector. */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['admin', 'editor', 'author', 'reader'])

export const postStatusEnum = pgEnum('post_status', [
  'draft',
  'in_review',
  'scheduled',
  'published',
  'archived',
])



export const commentStatusEnum = pgEnum('comment_status', [
  'pending',
  'approved',
  'spam',
  'deleted',
])

export const subscriberStatusEnum = pgEnum('subscriber_status', [
  'pending',
  'confirmed',
  'unsubscribed',
  'bounced',
])

export const reactionTypeEnum = pgEnum('reaction_type', ['like', 'bookmark'])

export const audioStatusEnum = pgEnum('audio_status', [
  'none',
  'queued',
  'processing',
  'ready',
  'failed',
])

// ─────────────────────────────────────────────────────────────────────────────
// users — readers, authors, editors and admins in one table
// ─────────────────────────────────────────────────────────────────────────────
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    passwordHash: text('password_hash'),

    name: varchar('name', { length: 120 }).notNull(),
    /** Author-page URL segment: /author/<slug>. Null for plain readers. */
    slug: varchar('slug', { length: 120 }),
    role: userRoleEnum('role').notNull().default('reader'),

    // ── E-E-A-T signals, surfaced on author pages and in Person JSON-LD ──
    bio: text('bio'),
    jobTitle: varchar('job_title', { length: 160 }),
    /** Free-form credentials, e.g. "ex-Vercel, 12 years in distributed systems". */
    credentials: text('credentials'),
    avatarUrl: text('avatar_url'),
    /** { x, github, linkedin, website, mastodon } — becomes Person.sameAs. */
    socials: jsonb('socials').$type<Record<string, string>>().default({}).notNull(),
    knowsAbout: jsonb('knows_about').$type<string[]>().default([]).notNull(),

    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    // Partial unique: many readers have no slug, but every author slug is
    // unique because it becomes a public URL.
    uniqueIndex('users_slug_key')
      .on(t.slug)
      .where(sql`${t.slug} IS NOT NULL`),
    index('users_role_idx').on(t.role),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// refresh_tokens — rotating refresh tokens with reuse detection
// ─────────────────────────────────────────────────────────────────────────────
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token. The raw token is never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Set when this token is rotated, so replaying it is detectable. */
    replacedByTokenHash: varchar('replaced_by_token_hash', { length: 64 }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    ip: varchar('ip', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_key').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
    index('refresh_tokens_expires_idx').on(t.expiresAt),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// categories — one per URL segment, hierarchical
// ─────────────────────────────────────────────────────────────────────────────

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})




export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 140 }).notNull(),
    description: text('description'),
    /**
     * Unique editorial intro rendered above the listing. Required before a
     * category page is indexable — without it the page is a bare list of
     * links, which reads as thin content.
     */
    introText: text('intro_text'),

    /** Tailwind class pair for the category colour tag. */
    tone: varchar('tone', { length: 160 }),
    icon: varchar('icon', { length: 60 }),
    coverImageUrl: text('cover_image_url'),

    parentId: uuid('parent_id'),
    position: smallint('position').notNull().default(0),
    featured: boolean('featured').notNull().default(false),

    // ── Per-page SEO overrides ──
    metaTitle: varchar('meta_title', { length: 70 }),
    metaDescription: varchar('meta_description', { length: 200 }),
    canonicalUrl: text('canonical_url'),
    ogImage: text('og_image'),
    noIndex: boolean('no_index').notNull().default(false),

    postCount: integer('post_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('categories_slug_key').on(t.slug),
    index('categories_parent_idx').on(t.parentId),
    index('categories_position_idx').on(t.position),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// tags
// ─────────────────────────────────────────────────────────────────────────────
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 80 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: text('description'),

    metaTitle: varchar('meta_title', { length: 70 }),
    metaDescription: varchar('meta_description', { length: 200 }),
    /**
     * Denormalised so the "thin tag page" rule is a cheap read: a tag with
     * fewer than N published posts is served noindex rather than adding a
     * near-empty page to the index.
     */
    postCount: integer('post_count').notNull().default(0),
    noIndex: boolean('no_index').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tags_slug_key').on(t.slug),
    index('tags_post_count_idx').on(t.postCount),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// series — pillar collections for topic clusters
// ─────────────────────────────────────────────────────────────────────────────
export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 180 }).notNull(),
    slug: varchar('slug', { length: 200 }).notNull(),
    description: text('description'),
    coverImageUrl: text('cover_image_url'),

    metaTitle: varchar('meta_title', { length: 70 }),
    metaDescription: varchar('meta_description', { length: 200 }),
    ogImage: text('og_image'),

    /** The pillar post this cluster points at, if there is one. */
    pillarPostId: uuid('pillar_post_id'),
    postCount: integer('post_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('series_slug_key').on(t.slug)]
)

// ─────────────────────────────────────────────────────────────────────────────
// media
// ─────────────────────────────────────────────────────────────────────────────
export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    /** Provider id (Cloudinary public_id / S3 key) for deletes and transforms. */
    providerId: text('provider_id'),
    provider: varchar('provider', { length: 32 }).notNull().default('cloudinary'),

    /** Width and height are required: next/image needs them to reserve space. */
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    format: varchar('format', { length: 16 }),
    bytes: integer('bytes'),

    /** Alt text is enforced at publish time, not here, so drafts can be saved. */
    alt: text('alt'),
    caption: text('caption'),
    credit: text('credit'),

    uploadedBy: uuid('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('media_uploaded_by_idx').on(t.uploadedBy)]
)

// ─────────────────────────────────────────────────────────────────────────────
// posts
// ─────────────────────────────────────────────────────────────────────────────
export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 200 }).notNull(),

    /**
     * The language this post is WRITTEN in.
     *
     * A post is one language. A Hindi version of an English article is a
     * separate row — written by a person, with its own word count, reading
     * time and search vector — linked back through `translationOfId`. Storing
     * both languages in one row would mean every query carries columns it does
     * not want and the full-text index covers two languages at once.
     */
    locale: varchar('locale', { length: 5 }).notNull().default('en'),

    /**
     * The post this one is a translation OF.
     *
     * Points at the ORIGINAL, never at another translation, so the set of
     * versions is a star rather than a chain — `WHERE id = x OR
     * translation_of_id = x` finds every language in one query.
     *
     * `set null` on delete: losing the English original must not delete the
     * Hindi article someone wrote, it just makes it a standalone post.
     */
    translationOfId: uuid('translation_of_id'),

    title: varchar('title', { length: 200 }).notNull(),
    subtitle: varchar('subtitle', { length: 300 }),
    excerpt: text('excerpt'),

    /** TipTap document. The editor's source of truth. */
    content: jsonb('content').$type<unknown>(),
    /** Sanitised HTML, rendered once on save so reads never re-render. */
    contentHtml: text('content_html'),
    /** Plain text, for word count, reading time, search and TTS. */
    contentText: text('content_text'),

    coverImageId: uuid('cover_image_id').references(() => media.id, {
      onDelete: 'set null',
    }),
    coverImageUrl: text('cover_image_url'),
    coverImageAlt: text('cover_image_alt'),

    status: postStatusEnum('status').notNull().default('draft'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    seriesId: uuid('series_id').references(() => series.id, {
      onDelete: 'set null',
    }),
    seriesPosition: smallint('series_position'),

    // ── SEO (Phase 2 gate) ──────────────────────────────────────────────────
    metaTitle: varchar('meta_title', { length: 70 }),
    metaDescription: varchar('meta_description', { length: 200 }),
    /** Set only when the canonical should point elsewhere (syndication). */
    canonicalUrl: text('canonical_url'),
    ogImage: text('og_image'),
    focusKeyword: varchar('focus_keyword', { length: 120 }),
    secondaryKeywords: jsonb('secondary_keywords')
      .$type<string[]>()
      .default([])
      .notNull(),
    noIndex: boolean('no_index').notNull().default(false),
    /** Cached result of the editor's SEO checklist, 0-100. */
    seoScore: smallint('seo_score'),

    /** FAQ block, rendered as an accordion and as FAQPage JSON-LD. */
    faq: jsonb('faq')
      .$type<{ question: string; answer: string }[]>()
      .default([])
      .notNull(),

    // ── Listen-to-article (Phase 6 populates; schema lands now) ─────────────
    audioStatus: audioStatusEnum('audio_status').notNull().default('none'),
    audioUrl: text('audio_url'),
    /** Seconds. Drives AudioObject.duration and the player's time display. */
    audioDuration: integer('audio_duration'),
    /**
     * Hash of the exact text that was synthesised. Regeneration is skipped
     * when it matches, so an unchanged post never costs TTS credits twice.
     */
    audioHash: varchar('audio_hash', { length: 64 }),
    audioVoice: varchar('audio_voice', { length: 60 }),
    audioEnabled: boolean('audio_enabled').notNull().default(true),
    audioGeneratedAt: timestamp('audio_generated_at', { withTimezone: true }),

    // ── Editorial flags ─────────────────────────────────────────────────────
    featured: boolean('featured').notNull().default(false),
    editorsPick: boolean('editors_pick').notNull().default(false),
    allowComments: boolean('allow_comments').notNull().default(true),

    // ── Derived metrics ─────────────────────────────────────────────────────
    wordCount: integer('word_count').notNull().default(0),
    readingMinutes: smallint('reading_minutes').notNull().default(1),
    viewCount: integer('view_count').notNull().default(0),
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    /** Surfaced as "Last reviewed" and as dateModified in JSON-LD. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Weighted search vector, maintained by Postgres rather than application
     * code so it can never drift from the row.
     *   A title + focus keyword · B subtitle + excerpt · C body
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      /*
       * The text search configuration is chosen PER ROW from its locale.
       *
       * `to_tsvector('english', …)` applies English stemming and an English
       * stop-word list. Run over Devanagari it does neither usefully — and
       * worse, Postgres has no Hindi configuration at all, so the only honest
       * option is `simple`, which lowercases and splits on whitespace without
       * pretending to understand the language.
       *
       * Hardcoding 'english' would have quietly given Hindi articles a search
       * index built by the wrong rules. `simple` finds exact words, which is
       * the correct floor rather than a wrong guess.
       */
      (): SQL => sql`
        CASE WHEN ${posts.locale} = 'en' THEN
          setweight(to_tsvector('english', coalesce(${posts.title}, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(${posts.focusKeyword}, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(${posts.subtitle}, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(${posts.excerpt}, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(${posts.contentText}, '')), 'C')
        ELSE
          setweight(to_tsvector('simple', coalesce(${posts.title}, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(${posts.focusKeyword}, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(${posts.subtitle}, '')), 'B') ||
          setweight(to_tsvector('simple', coalesce(${posts.excerpt}, '')), 'B') ||
          setweight(to_tsvector('simple', coalesce(${posts.contentText}, '')), 'C')
        END
      `
    ),
  },
  (t) => [
    /*
     * Unique per (slug, locale), NOT per slug.
     *
     * A translation deliberately shares its original's slug so the two differ
     * only by the locale prefix — `/blog/x` and `/hi/blog/x`. That is what
     * makes the language switcher a pure path transformation, and it keeps
     * hreflang pairs obvious. A unique index on slug alone made that
     * impossible.
     */
    uniqueIndex('posts_slug_locale_key').on(t.slug, t.locale),
    // Every public listing filters by locale first.
    index('posts_locale_status_published_idx').on(
      t.locale,
      t.status,
      t.publishedAt.desc()
    ),
    index('posts_translation_of_idx').on(t.translationOfId),
    // The listing query: published posts, newest first.
    index('posts_status_published_idx').on(t.status, t.publishedAt.desc()),
    // Category and author archive pages.
    index('posts_category_published_idx').on(
      t.categoryId,
      t.status,
      t.publishedAt.desc()
    ),
    index('posts_author_published_idx').on(t.authorId, t.status, t.publishedAt.desc()),
    index('posts_series_idx').on(t.seriesId, t.seriesPosition),
    // Partial indexes: the homepage rails read only a handful of flagged rows.
    index('posts_featured_idx')
      .on(t.publishedAt.desc())
      .where(sql`${t.featured} = true AND ${t.status} = 'published'`),
    index('posts_editors_pick_idx')
      .on(t.publishedAt.desc())
      .where(sql`${t.editorsPick} = true AND ${t.status} = 'published'`),
    // The scheduler polls this; partial keeps it tiny.
    index('posts_scheduled_idx')
      .on(t.scheduledFor)
      .where(sql`${t.status} = 'scheduled'`),
    index('posts_search_idx').using('gin', t.searchVector),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// post_tags — many-to-many
// ─────────────────────────────────────────────────────────────────────────────
export const postTags = pgTable(
  'post_tags',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('post_tags_pkey').on(t.postId, t.tagId),
    // Reverse lookup for tag archive pages.
    index('post_tags_tag_idx').on(t.tagId),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// post_reactions — likes and bookmarks
// ─────────────────────────────────────────────────────────────────────────────
export const postReactions = pgTable(
  'post_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: reactionTypeEnum('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One reaction of each kind per user per post, enforced by the database.
     * A double-click, a retried request or two tabs would otherwise insert
     * duplicates and inflate the like count — and a counter you cannot trust
     * is worse than no counter.
     */
    uniqueIndex('post_reactions_unique').on(t.postId, t.userId, t.type),
    // "What has this user bookmarked?" for the saved-posts screen.
    index('post_reactions_user_idx').on(t.userId, t.type, t.createdAt.desc()),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// post_revisions — autosave + version history
// ─────────────────────────────────────────────────────────────────────────────
export const postRevisions = pgTable(
  'post_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    title: varchar('title', { length: 200 }).notNull(),
    content: jsonb('content').$type<unknown>(),
    /** True for periodic autosaves, false for explicit saves. */
    isAutosave: boolean('is_autosave').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('post_revisions_post_idx').on(t.postId, t.createdAt.desc())]
)

// ─────────────────────────────────────────────────────────────────────────────
// redirects — the slug-change 301 engine
// ─────────────────────────────────────────────────────────────────────────────
export const redirects = pgTable(
  'redirects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Always stored with a leading slash and no trailing slash. */
    fromPath: varchar('from_path', { length: 400 }).notNull(),
    toPath: varchar('to_path', { length: 400 }).notNull(),
    statusCode: smallint('status_code').notNull().default(301),
    /** 'slug_change' rows are created automatically; 'manual' by an admin. */
    reason: varchar('reason', { length: 40 }).notNull().default('manual'),
    /**
     * SET NULL, never CASCADE. These rows exist precisely to keep serving a
     * URL after the post is gone — cascading would delete the redirect at the
     * exact moment it becomes necessary.
     */
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'set null' }),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One destination per source. This is what makes redirect creation
    // idempotent and prevents ambiguous chains.
    uniqueIndex('redirects_from_path_key').on(t.fromPath),
    index('redirects_post_idx').on(t.postId),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// comments — threaded and moderated
// ─────────────────────────────────────────────────────────────────────────────
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Guest identity, used only when userId is null. */
    guestName: varchar('guest_name', { length: 80 }),
    guestEmail: citext('guest_email'),

    body: text('body').notNull(),
    bodyHtml: text('body_html').notNull(),
    status: commentStatusEnum('status').notNull().default('pending'),

    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The render query: approved comments for a post, oldest first.
    index('comments_post_status_idx').on(t.postId, t.status, t.createdAt),
    index('comments_parent_idx').on(t.parentId),
    // The moderation queue.
    index('comments_moderation_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.status} = 'pending'`),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// subscribers — double opt-in newsletter
// ─────────────────────────────────────────────────────────────────────────────
export const subscribers = pgTable(
  'subscribers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    status: subscriberStatusEnum('status').notNull().default('pending'),
    /** SHA-256 of the confirm/unsubscribe token. */
    tokenHash: varchar('token_hash', { length: 64 }),
    source: varchar('source', { length: 40 }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscribers_email_key').on(t.email),
    index('subscribers_status_idx').on(t.status),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// settings — single-row-per-key site configuration
// ─────────────────────────────────────────────────────────────────────────────
export const settings = pgTable('settings', {
  key: varchar('key', { length: 80 }).primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─────────────────────────────────────────────────────────────────────────────
// audit_logs
// ─────────────────────────────────────────────────────────────────────────────
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 80 }).notNull(),
    entity: varchar('entity', { length: 60 }),
    entityId: uuid('entity_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    ip: varchar('ip', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_user_idx').on(t.userId, t.createdAt.desc()),
    index('audit_logs_entity_idx').on(t.entity, t.entityId),
  ]
)

// ─────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
  refreshTokens: many(refreshTokens),
}))

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'category_parent',
  }),
  children: many(categories, { relationName: 'category_parent' }),
  posts: many(posts),
}))

export const seriesRelations = relations(series, ({ many }) => ({
  posts: many(posts),
}))

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  category: one(categories, {
    fields: [posts.categoryId],
    references: [categories.id],
  }),
  series: one(series, { fields: [posts.seriesId], references: [series.id] }),
  coverImage: one(media, {
    fields: [posts.coverImageId],
    references: [media.id],
  }),
  postTags: many(postTags),
  comments: many(comments),
  revisions: many(postRevisions),
}))

export const postReactionsRelations = relations(postReactions, ({ one }) => ({
  post: one(posts, { fields: [postReactions.postId], references: [posts.id] }),
  user: one(users, { fields: [postReactions.userId], references: [users.id] }),
}))

export const tagsRelations = relations(tags, ({ many }) => ({
  postTags: many(postTags),
}))

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}))

export const commentsRelations = relations(comments, ({ one, many }) => ({
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] }),
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: 'comment_parent',
  }),
  replies: many(comments, { relationName: 'comment_parent' }),
}))

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types
// ─────────────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Post = typeof posts.$inferSelect
export type NewPost = typeof posts.$inferInsert
export type Category = typeof categories.$inferSelect
export type NewCategory = typeof categories.$inferInsert
export type Tag = typeof tags.$inferSelect
export type NewTag = typeof tags.$inferInsert
export type Series = typeof series.$inferSelect
export type Comment = typeof comments.$inferSelect
export type Redirect = typeof redirects.$inferSelect
export type Subscriber = typeof subscribers.$inferSelect
export type Media = typeof media.$inferSelect
export type PostReaction = typeof postReactions.$inferSelect

export type UserRole = (typeof userRoleEnum.enumValues)[number]
export type PostStatus = (typeof postStatusEnum.enumValues)[number]
export type ReactionType = (typeof reactionTypeEnum.enumValues)[number]
