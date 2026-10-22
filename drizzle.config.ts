import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit configuration.
 *
 * Migrations are generated into ./drizzle and committed. They are applied with
 * `npm run db:migrate`, never with `db:push` outside local development --
 * push diffs the live schema and can silently drop a column.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
