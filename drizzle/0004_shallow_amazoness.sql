ALTER TABLE "posts" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (
        CASE WHEN "posts"."locale" = 'en' THEN
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
      ) STORED;