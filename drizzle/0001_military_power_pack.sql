ALTER TABLE "redirects" DROP CONSTRAINT "redirects_post_id_posts_id_fk";
--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;