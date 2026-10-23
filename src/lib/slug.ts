



/**
 * Slug generation.
 *
 * This implementation is mirrored byte-for-byte by `slugify()` in
 * `client/src/lib/utils.ts`, so the slug the editor previews is always the
 * slug that gets persisted. If you change one, change the other.
 */

/** Maximum slug length. Long URLs are truncated on a word boundary. */
const MAX_LENGTH = 80

export function slugify(input: string): string {
  return (
    input
      // Decompose accented characters so the diacritic can be stripped
      // separately, turning "crème brûlée" into "creme-brulee" rather than
      // dropping the letters entirely.
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_LENGTH)
      // Truncation can leave a trailing hyphen mid-word.
      .replace(/-+$/g, '')
  )
}

/**
 * Appends a numeric suffix until the slug is free.
 *
 * `isTaken` is injected rather than querying here so the same function serves
 * posts, categories, tags, series and author slugs, and so it can be unit
 * tested without a database.
 *
 * Starts at `-2` because the unsuffixed slug is conceptually "1".
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  maxAttempts = 50
): Promise<string> {
  const root = slugify(base) || 'untitled'

  if (!(await isTaken(root))) return root

  for (let n = 2; n <= maxAttempts; n++) {
    const suffix = `-${n}`
    // Keep the whole thing inside MAX_LENGTH even after the suffix.
    const candidate = `${root.slice(0, MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!(await isTaken(candidate))) return candidate
  }

  // Fall back to a random discriminator rather than looping forever.
  return `${root.slice(0, MAX_LENGTH - 7).replace(/-+$/, '')}-${Date.now().toString(36).slice(-5)}`
}

/**
 * Normalises a path for storage and comparison in the redirects table:
 * always one leading slash, never a trailing one, query and hash removed,
 * lower-cased.
 *
 * Without this, `/blog/post`, `/blog/post/` and `/Blog/Post` would be three
 * different rows pointing at the same page.
 */
export function normalisePath(path: string): string {
  const [withoutHash = ''] = path.split('#')
  const [withoutQuery = ''] = withoutHash.split('?')
  const trimmed = withoutQuery.trim().toLowerCase()
  if (!trimmed || trimmed === '/') return '/'
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.replace(/\/+$/, '') || '/'
}

/** The public URL path for a post slug. Single source of truth for the shape. */
export function postPath(slug: string): string {
  return `/blog/${slug}`
}
