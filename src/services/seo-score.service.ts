/**
 * ═════════════════════════════════════════════════════════════════════════════
 * SEO SCORE
 * ═════════════════════════════════════════════════════════════════════════════
 * The checklist behind the editor's live score panel.
 *
 * It lives on the SERVER, not in the editor, for one reason: the same function
 * decides whether a post may be published. If the score were computed in the
 * browser, a direct API call could publish a post the UI would have blocked.
 * The editor calls this endpoint to render the panel; the publish path calls
 * the same function to enforce it.
 *
 * Checks are weighted by how much they actually move rankings, not by how easy
 * they are to measure. Keyword density, for instance, is deliberately a weak
 * signal with a penalty for stuffing rather than a reward for repetition.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail'

export type SeoCheck = {
  id: string
  label: string
  status: CheckStatus
  /** What the writer should do about it. Empty when passing. */
  hint: string
  weight: number
  /** False for checks that are advisory only and never block publishing. */
  blocking: boolean
}

export type SeoReport = {
  score: number
  checks: SeoCheck[]
  blockers: SeoCheck[]
  wordCount: number
  readingMinutes: number
  keywordDensity: number
}

export type SeoInput = {
  title?: string | null
  metaTitle?: string | null
  metaDescription?: string | null
  slug?: string | null
  excerpt?: string | null
  focusKeyword?: string | null
  contentHtml?: string | null
  contentText?: string | null
  coverImageUrl?: string | null
  coverImageAlt?: string | null
  categoryId?: string | null
  tagCount?: number
}

const TITLE_MIN = 30
const TITLE_MAX = 60
const DESC_MIN = 140
const DESC_MAX = 160
const MIN_WORDS = 1000
const WORDS_PER_MINUTE = 225

/** Case- and punctuation-insensitive containment. */
function contains(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || !needle) return false
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return normalise(haystack).includes(normalise(needle))
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function scorePost(input: SeoInput): SeoReport {
  const html = input.contentHtml ?? ''
  const text = (input.contentText ?? stripTags(html)).trim()
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0
  const keyword = (input.focusKeyword ?? '').trim()
  const effectiveTitle = input.metaTitle ?? input.title ?? ''

  const checks: SeoCheck[] = []
  const add = (
    id: string,
    label: string,
    status: CheckStatus,
    hint: string,
    weight: number,
    blocking = false
  ) => checks.push({ id, label, status, hint, weight, blocking })

  // ── Focus keyword ───────────────────────────────────────────────────────
  if (!keyword) {
    add(
      'keyword',
      'Focus keyword set',
      'fail',
      'Pick the one query this post should rank for.',
      10,
      true
    )
  } else {
    add('keyword', 'Focus keyword set', 'pass', '', 10, true)

    add(
      'keyword-title',
      'Keyword in the title',
      contains(effectiveTitle, keyword) ? 'pass' : 'fail',
      'Google weights the title heavily. Work the keyword in naturally.',
      10
    )

    add(
      'keyword-slug',
      'Keyword in the URL',
      contains(input.slug, keyword) ? 'pass' : 'warn',
      'Short, keyword-bearing slugs read better in results and in links.',
      5
    )

    // First paragraph, approximated as the opening 160 words.
    const opening = text.split(/\s+/).slice(0, 160).join(' ')
    add(
      'keyword-intro',
      'Keyword in the opening',
      contains(opening, keyword) ? 'pass' : 'warn',
      'Mention the keyword in the first paragraph so the topic is clear immediately.',
      6
    )

    add(
      'keyword-meta',
      'Keyword in the meta description',
      contains(input.metaDescription, keyword) ? 'pass' : 'warn',
      'The keyword is bolded in results when it appears in the description.',
      4
    )

    const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) =>
      stripTags(m[1] ?? '')
    )
    add(
      'keyword-heading',
      'Keyword in a subheading',
      headings.some((h) => contains(h, keyword)) ? 'pass' : 'warn',
      'At least one H2 should carry the keyword or a close variant.',
      4
    )
  }

  // ── Title ───────────────────────────────────────────────────────────────
  const titleLength = effectiveTitle.length
  add(
    'title-length',
    `Title length (${titleLength} chars)`,
    titleLength === 0
      ? 'fail'
      : titleLength >= TITLE_MIN && titleLength <= TITLE_MAX
        ? 'pass'
        : 'warn',
    titleLength > TITLE_MAX
      ? `Over ${TITLE_MAX} characters is truncated in results.`
      : `Aim for ${TITLE_MIN}-${TITLE_MAX} characters.`,
    8,
    titleLength === 0
  )

  // ── Meta description ────────────────────────────────────────────────────
  const descLength = (input.metaDescription ?? '').length
  add(
    'meta-description',
    `Meta description (${descLength} chars)`,
    descLength === 0
      ? 'fail'
      : descLength >= DESC_MIN && descLength <= DESC_MAX
        ? 'pass'
        : 'warn',
    descLength === 0
      ? 'Write a description; without one Google invents a snippet.'
      : `Aim for ${DESC_MIN}-${DESC_MAX} characters.`,
    10,
    descLength < DESC_MIN
  )

  // ── Length and depth ────────────────────────────────────────────────────
  add(
    'word-count',
    `Word count (${words})`,
    words >= MIN_WORDS ? 'pass' : words >= 600 ? 'warn' : 'fail',
    `The editorial standard is ${MIN_WORDS}+ words. Thin posts rarely rank.`,
    10,
    words < 300
  )

  // ── Heading structure ───────────────────────────────────────────────────
  const h1Count = (html.match(/<h1(?=[\s>/])/gi) ?? []).length
  const h2Count = (html.match(/<h2(?=[\s>/])/gi) ?? []).length
  const h3Count = (html.match(/<h3(?=[\s>/])/gi) ?? []).length

  add(
    'no-h1-in-body',
    'No H1 inside the body',
    h1Count === 0 ? 'pass' : 'fail',
    'The page title is the H1. A second one breaks the document outline.',
    8,
    h1Count > 0
  )

  add(
    'headings',
    `Heading structure (${h2Count} H2, ${h3Count} H3)`,
    h2Count >= 2 ? 'pass' : h2Count === 1 ? 'warn' : 'fail',
    'Break the article into at least two H2 sections.',
    7,
    false
  )

  // An H3 before any H2 is a skipped level.
  const firstH2 = html.search(/<h2(?=[\s>/])/i)
  const firstH3 = html.search(/<h3(?=[\s>/])/i)
  add(
    'heading-order',
    'No skipped heading levels',
    firstH3 === -1 || (firstH2 !== -1 && firstH2 < firstH3) ? 'pass' : 'fail',
    'An H3 appears before the first H2, which skips a level.',
    5,
    firstH3 !== -1 && (firstH2 === -1 || firstH2 > firstH3)
  )

  // ── Images ──────────────────────────────────────────────────────────────
  add(
    'cover-image',
    'Cover image set',
    input.coverImageUrl ? 'pass' : 'fail',
    'Posts without a cover get no image in social cards or Discover.',
    6,
    !input.coverImageUrl
  )

  const coverAlt = (input.coverImageAlt ?? '').trim()
  add(
    'cover-alt',
    'Cover image alt text',
    coverAlt.length >= 10 ? 'pass' : 'fail',
    'Describe the image in a sentence. Required for accessibility and image search.',
    6,
    coverAlt.length < 10
  )

  const bodyImages = [...html.matchAll(/<img[^>]*>/gi)].map((m) => m[0])
  // An image counts as described only when `alt` is present AND non-empty, in
  // EITHER quote style. Matching only double quotes reported every
  // single-quoted image as missing alt text, which is a false positive that
  // would block a perfectly good publish.
  const missingAlt = bodyImages.filter((tag) => {
    const match = /\balt\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)
    return !match || (match[2] ?? '').trim().length === 0
  })
  add(
    'body-image-alt',
    `Body images have alt text (${bodyImages.length - missingAlt.length}/${bodyImages.length})`,
    bodyImages.length === 0 ? 'pass' : missingAlt.length === 0 ? 'pass' : 'fail',
    `${missingAlt.length} image(s) are missing alt text.`,
    6,
    missingAlt.length > 0
  )

  /*
   * ── Links ──────────────────────────────────────────────────────────────
   * All three legal attribute forms, not just the double-quoted one.
   *
   * `href="x"`, `href='x'` and bare `href=x` are each valid HTML, and
   * different editors and sanitisers emit different ones. A pattern that only
   * matched double quotes reported ZERO internal links for a well-linked
   * article — which is a nonsense score on the check that drives topic
   * clustering, and the same blind spot that previously made the alt-text
   * checks refuse to publish correctly described images.
   */
  const links = [
    ...html.matchAll(/<a[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi),
  ].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
  const internal = links.filter((href) => href.startsWith('/')).length
  const external = links.filter((href) => /^https?:\/\//i.test(href)).length

  add(
    'internal-links',
    `Internal links (${internal})`,
    internal >= 3 ? 'pass' : internal >= 1 ? 'warn' : 'fail',
    'Link to at least three related posts. This is how topic clusters form.',
    7
  )

  add(
    'external-links',
    `Authoritative external links (${external})`,
    external >= 2 ? 'pass' : 'warn',
    'Cite at least two primary sources. Citations are an E-E-A-T signal.',
    5
  )

  // ── Excerpt and taxonomy ────────────────────────────────────────────────
  add(
    'excerpt',
    'Excerpt written',
    (input.excerpt ?? '').length >= 50 ? 'pass' : 'fail',
    'The excerpt is the card copy and the fallback description.',
    4,
    (input.excerpt ?? '').length < 50
  )

  add(
    'category',
    'Category assigned',
    input.categoryId ? 'pass' : 'fail',
    'Every post belongs to exactly one category.',
    4,
    !input.categoryId
  )

  add(
    'tags',
    `Tags (${input.tagCount ?? 0})`,
    (input.tagCount ?? 0) >= 2 ? 'pass' : 'warn',
    'Two to five tags is the useful range.',
    3
  )

  // ── Keyword density ─────────────────────────────────────────────────────
  // Penalty-only: hitting a density target does not help, but stuffing hurts.
  let density = 0
  if (keyword && words > 0) {
    const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matches = text.toLowerCase().match(new RegExp(escaped, 'g')) ?? []
    density = Number(((matches.length / words) * 100).toFixed(2))

    add(
      'keyword-density',
      `Keyword density (${density}%)`,
      density > 3 ? 'fail' : density < 0.3 ? 'warn' : 'pass',
      density > 3
        ? 'Over 3% reads as keyword stuffing. Cut repetitions.'
        : 'The keyword barely appears. Use it where it reads naturally.',
      4
    )
  }

  // ── Score ───────────────────────────────────────────────────────────────
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0)
  const earned = checks.reduce((sum, check) => {
    if (check.status === 'pass') return sum + check.weight
    // A warning is a partial pass: it is a real issue, not a failure.
    if (check.status === 'warn') return sum + check.weight * 0.5
    return sum
  }, 0)

  return {
    score: totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100),
    checks,
    blockers: checks.filter((check) => check.blocking && check.status === 'fail'),
    wordCount: words,
    readingMinutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    keywordDensity: density,
  }
}
