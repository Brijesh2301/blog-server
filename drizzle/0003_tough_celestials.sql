-- ═══════════════════════════════════════════════════════════════════════════
-- Multilingual posts
-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-ordered. The generated version was wrong in two ways that would only
-- have shown up at run time:
--
--   1. It added the `search_vector` generated column, which references
--      `locale`, BEFORE adding `locale`. The migration simply fails.
--   2. Dropping `search_vector` cascades to `posts_search_idx`, the GIN index
--      behind full-text search — and nothing recreated it. Search would have
--      kept working and quietly fallen back to a sequential scan on every
--      query, which is the kind of regression you discover from a latency
--      graph months later.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. New columns FIRST, so the generated column below can reference them ──
ALTER TABLE "posts" ADD COLUMN "locale" varchar(5) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "translation_of_id" uuid;--> statement-breakpoint

-- Self-reference to the ORIGINAL post. `SET NULL`, not cascade: deleting an
-- English article must not delete the Hindi one someone wrote from it — that
-- translation simply becomes a standalone post.
ALTER TABLE "posts"
  ADD CONSTRAINT "posts_translation_of_id_fk"
  FOREIGN KEY ("translation_of_id") REFERENCES "posts"("id") ON DELETE SET NULL;--> statement-breakpoint

-- ── 2. Rebuild the search vector with a per-locale configuration ────────────
-- Postgres ships no Hindi text-search configuration, so Devanagari rows use
-- `simple` (lowercase + whitespace split) rather than being run through
-- English stemming, which would produce nonsense tokens.
--
-- The CASE wraps the WHOLE expression rather than selecting a config inside
-- `to_tsvector`. `(CASE … END)::regconfig` is only STABLE — a text-to-regconfig
-- cast depends on search_path — and a generated column requires IMMUTABLE, so
-- Postgres rejects it outright with "generation expression is not immutable".
-- A literal config in each branch is immutable, at the cost of writing the
-- five weights twice.
ALTER TABLE "posts" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (
        CASE WHEN locale = 'en' THEN
          setweight(to_tsvector('english', coalesce("posts"."title", '')), 'A') ||
          setweight(to_tsvector('english', coalesce("posts"."focus_keyword", '')), 'A') ||
          setweight(to_tsvector('english', coalesce("posts"."subtitle", '')), 'B') ||
          setweight(to_tsvector('english', coalesce("posts"."excerpt", '')), 'B') ||
          setweight(to_tsvector('english', coalesce("posts"."content_text", '')), 'C')
        ELSE
          setweight(to_tsvector('simple', coalesce("posts"."title", '')), 'A') ||
          setweight(to_tsvector('simple', coalesce("posts"."focus_keyword", '')), 'A') ||
          setweight(to_tsvector('simple', coalesce("posts"."subtitle", '')), 'B') ||
          setweight(to_tsvector('simple', coalesce("posts"."excerpt", '')), 'B') ||
          setweight(to_tsvector('simple', coalesce("posts"."content_text", '')), 'C')
        END
      ) STORED;--> statement-breakpoint

-- Recreate the GIN index the DROP COLUMN above cascaded away.
CREATE INDEX "posts_search_idx" ON "posts" USING gin ("search_vector");--> statement-breakpoint

-- ── 3. Slugs are unique PER LOCALE, not globally ────────────────────────────
-- A translation shares its original's slug on purpose, so the two URLs differ
-- only by the locale prefix: /blog/x and /hi/blog/x. That makes the language
-- switcher a pure path transformation and keeps hreflang pairs obvious.
DROP INDEX "posts_slug_key";--> statement-breakpoint
CREATE UNIQUE INDEX "posts_slug_locale_key" ON "posts" USING btree ("slug","locale");--> statement-breakpoint

CREATE INDEX "posts_locale_status_published_idx" ON "posts" USING btree ("locale","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_translation_of_idx" ON "posts" USING btree ("translation_of_id");
