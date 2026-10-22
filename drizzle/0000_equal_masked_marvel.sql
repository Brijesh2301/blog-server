-- Extensions must exist before any citext column or trigram index is created.
-- drizzle-kit cannot express these, so they are prepended by hand. All three
-- are idempotent, so re-running the migration is safe.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE TYPE "public"."audio_status" AS ENUM('none', 'queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."comment_status" AS ENUM('pending', 'approved', 'spam', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'in_review', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."subscriber_status" AS ENUM('pending', 'confirmed', 'unsubscribed', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'editor', 'author', 'reader');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" varchar(80) NOT NULL,
	"entity" varchar(60),
	"entity_id" uuid,
	"meta" jsonb,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(140) NOT NULL,
	"description" text,
	"intro_text" text,
	"tone" varchar(160),
	"icon" varchar(60),
	"cover_image_url" text,
	"parent_id" uuid,
	"position" smallint DEFAULT 0 NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"meta_title" varchar(70),
	"meta_description" varchar(200),
	"canonical_url" text,
	"og_image" text,
	"no_index" boolean DEFAULT false NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"parent_id" uuid,
	"user_id" uuid,
	"guest_name" varchar(80),
	"guest_email" "citext",
	"body" text NOT NULL,
	"body_html" text NOT NULL,
	"status" "comment_status" DEFAULT 'pending' NOT NULL,
	"ip" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"provider_id" text,
	"provider" varchar(32) DEFAULT 'cloudinary' NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"format" varchar(16),
	"bytes" integer,
	"alt" text,
	"caption" text,
	"credit" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" uuid,
	"title" varchar(200) NOT NULL,
	"content" jsonb,
	"is_autosave" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_tags" (
	"post_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(200) NOT NULL,
	"title" varchar(200) NOT NULL,
	"subtitle" varchar(300),
	"excerpt" text,
	"content" jsonb,
	"content_html" text,
	"content_text" text,
	"cover_image_id" uuid,
	"cover_image_url" text,
	"cover_image_alt" text,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"author_id" uuid NOT NULL,
	"category_id" uuid,
	"series_id" uuid,
	"series_position" smallint,
	"meta_title" varchar(70),
	"meta_description" varchar(200),
	"canonical_url" text,
	"og_image" text,
	"focus_keyword" varchar(120),
	"secondary_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_index" boolean DEFAULT false NOT NULL,
	"seo_score" smallint,
	"faq" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audio_status" "audio_status" DEFAULT 'none' NOT NULL,
	"audio_url" text,
	"audio_duration" integer,
	"audio_hash" varchar(64),
	"audio_voice" varchar(60),
	"audio_enabled" boolean DEFAULT true NOT NULL,
	"audio_generated_at" timestamp with time zone,
	"featured" boolean DEFAULT false NOT NULL,
	"editors_pick" boolean DEFAULT false NOT NULL,
	"allow_comments" boolean DEFAULT true NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"reading_minutes" smallint DEFAULT 1 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"scheduled_for" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("posts"."title", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("posts"."focus_keyword", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("posts"."subtitle", '')), 'B') ||
        setweight(to_tsvector('english', coalesce("posts"."excerpt", '')), 'B') ||
        setweight(to_tsvector('english', coalesce("posts"."content_text", '')), 'C')
      ) STORED
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_path" varchar(400) NOT NULL,
	"to_path" varchar(400) NOT NULL,
	"status_code" smallint DEFAULT 301 NOT NULL,
	"reason" varchar(40) DEFAULT 'manual' NOT NULL,
	"post_id" uuid,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"replaced_by_token_hash" varchar(64),
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(180) NOT NULL,
	"slug" varchar(200) NOT NULL,
	"description" text,
	"cover_image_url" text,
	"meta_title" varchar(70),
	"meta_description" varchar(200),
	"og_image" text,
	"pillar_post_id" uuid,
	"post_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"status" "subscriber_status" DEFAULT 'pending' NOT NULL,
	"token_hash" varchar(64),
	"source" varchar(40),
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"meta_title" varchar(70),
	"meta_description" varchar(200),
	"post_count" integer DEFAULT 0 NOT NULL,
	"no_index" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text,
	"name" varchar(120) NOT NULL,
	"slug" varchar(120),
	"role" "user_role" DEFAULT 'reader' NOT NULL,
	"bio" text,
	"job_title" varchar(160),
	"credentials" text,
	"avatar_url" text,
	"socials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"knows_about" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email_verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_cover_image_id_media_id_fk" FOREIGN KEY ("cover_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_key" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "categories_position_idx" ON "categories" USING btree ("position");--> statement-breakpoint
CREATE INDEX "comments_post_status_idx" ON "comments" USING btree ("post_id","status","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "comments_moderation_idx" ON "comments" USING btree ("created_at" DESC NULLS LAST) WHERE "comments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "media_uploaded_by_idx" ON "media" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "post_revisions_post_idx" ON "post_revisions" USING btree ("post_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "post_tags_pkey" ON "post_tags" USING btree ("post_id","tag_id");--> statement-breakpoint
CREATE INDEX "post_tags_tag_idx" ON "post_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_slug_key" ON "posts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "posts_status_published_idx" ON "posts" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_category_published_idx" ON "posts" USING btree ("category_id","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_author_published_idx" ON "posts" USING btree ("author_id","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_series_idx" ON "posts" USING btree ("series_id","series_position");--> statement-breakpoint
CREATE INDEX "posts_featured_idx" ON "posts" USING btree ("published_at" DESC NULLS LAST) WHERE "posts"."featured" = true AND "posts"."status" = 'published';--> statement-breakpoint
CREATE INDEX "posts_editors_pick_idx" ON "posts" USING btree ("published_at" DESC NULLS LAST) WHERE "posts"."editors_pick" = true AND "posts"."status" = 'published';--> statement-breakpoint
CREATE INDEX "posts_scheduled_idx" ON "posts" USING btree ("scheduled_for") WHERE "posts"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "posts_search_idx" ON "posts" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "redirects_from_path_key" ON "redirects" USING btree ("from_path");--> statement-breakpoint
CREATE INDEX "redirects_post_idx" ON "redirects" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "series_slug_key" ON "series" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_email_key" ON "subscribers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "subscribers_status_idx" ON "subscribers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_slug_key" ON "tags" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tags_post_count_idx" ON "tags" USING btree ("post_count");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_slug_key" ON "users" USING btree ("slug") WHERE "users"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");