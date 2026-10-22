import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { renderCommentHtml } from './comment.service.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * COMMENT RENDERING
 * ═════════════════════════════════════════════════════════════════════════════
 * These are regression tests, not coverage. Every case below corresponds to a
 * bug that was actually shipped and caught by reading rendered HTML:
 *
 *  - `allowedAttributes: { a: ['href'] }` silently stripped the `rel` that
 *    `transformTags` had just added, because sanitize-html filters attributes
 *    AFTER running transforms. Every approved comment link was a plain
 *    followable link out of the domain — the exact thing the feature exists to
 *    prevent, and invisible unless you inspect the output.
 *  - Commenters type bare URLs, not anchors. Without autolinking, no <a> was
 *    ever produced and the rel policy never ran on anything at all.
 *
 * Both failures were silent: the API returned 200, the page rendered, and the
 * only symptom was HTML nobody was looking at. That is what makes them worth
 * pinning here.
 */

/** Every anchor in a string, as a list of opening tags. */
function anchors(html: string): string[] {
  return html.match(/<a\s[^>]*>/g) ?? []
}

describe('renderCommentHtml', () => {
  test('forces rel="ugc nofollow noopener noreferrer" on autolinked URLs', () => {
    const html = renderCommentHtml('See https://example.com for the details.')
    const tags = anchors(html)

    assert.equal(tags.length, 1, 'the bare URL should become exactly one link')
    assert.match(tags[0]!, /rel="ugc nofollow noopener noreferrer"/)
  })

  test('rel survives the attribute allowlist', () => {
    // The specific regression: a transform added `rel`, then the allowlist
    // removed it again. Asserting the attribute SURVIVES is the point.
    const html = renderCommentHtml('https://spam.example/buy')
    assert.ok(html.includes('rel='), 'rel must not be stripped by allowedAttributes')
    assert.ok(html.includes('ugc'), 'rel must still contain ugc')
  })

  test('autolinks every URL in a multi-link comment', () => {
    const html = renderCommentHtml(
      'Two refs: https://a.example/one and https://b.example/two.'
    )
    const tags = anchors(html)

    assert.equal(tags.length, 2)
    assert.ok(tags.every((tag) => tag.includes('ugc')))
  })

  test('does not swallow trailing punctuation into the href', () => {
    // "see https://example.com." must not link the full stop — the resulting
    // URL 404s for everyone who clicks it.
    const html = renderCommentHtml('Read https://example.com/page.')
    assert.ok(html.includes('href="https://example.com/page"'))
    assert.ok(html.endsWith('.</p>'), 'the full stop stays outside the anchor')
  })

  test('escapes HTML in the body rather than rendering it', () => {
    const html = renderCommentHtml('Edge case: <script>alert(1)</script> inside.')

    assert.ok(!html.includes('<script'), 'no script tag may survive')
    assert.ok(html.includes('&lt;script&gt;'), 'it should be visible as text')
  })

  test('cannot be tricked into emitting an attacker-authored anchor', () => {
    // Escaping runs BEFORE autolinking, so the typed tag is inert text. The
    // URL inside it still autolinks — which is fine, and in fact the point:
    // whatever link ends up on the page is OURS, with our rel.
    const html = renderCommentHtml('<a href="https://evil.example" rel="dofollow">x</a>')

    // "dofollow" DOES appear — as the inert escaped text the commenter typed,
    // which is correct. What must never happen is it appearing as an
    // attribute, so the assertion is about the tags, not the whole string.
    assert.ok(html.includes('&lt;a href='), 'the typed tag stays visible as text')
    assert.ok(!/<a\s[^>]*dofollow/.test(html), 'no anchor may carry the typed rel')

    const tags = anchors(html)
    assert.equal(tags.length, 1, 'only the URL autolinks, not the typed tag')
    assert.match(tags[0]!, /rel="ugc nofollow noopener noreferrer"/)
    assert.match(tags[0]!, /href="https:\/\/evil\.example"/, 'href must be clean')
  })

  test('an escaped quote does not leak into the href', () => {
    // The regression: autolinking runs on escaped text, so a typed quote sits
    // in the string as `&quot;` — no whitespace, no `<` — and the URL pattern
    // swallowed it, producing a link to the wrong URL plus a stray `;` in the
    // visible text. This hit ordinary prose, not just crafted input.
    const html = renderCommentHtml('He said "go to https://example.com/x" loudly')

    assert.ok(html.includes('href="https://example.com/x"'), 'href must be clean')
    assert.ok(!html.includes('&quot;"'), 'no escaped quote inside the href')
    assert.ok(!/<\/a>;/.test(html), 'no orphaned semicolon after the link')
  })

  test('a real ampersand in a query string survives', () => {
    // `&amp;` must NOT be treated as an escaped delimiter — it is a genuine
    // `&` and cutting there would truncate the URL.
    const html = renderCommentHtml('https://example.com/a?x=1&y=2&z=3')
    assert.ok(html.includes('href="https://example.com/a?x=1&amp;y=2&amp;z=3"'))
  })

  test('a javascript: URL never becomes a link', () => {
    const html = renderCommentHtml('try javascript:alert(1) here')
    assert.equal(anchors(html).length, 0)
    assert.ok(!html.includes('href'))
  })

  test('allows no headings, so a comment cannot enter the page outline', () => {
    const html = renderCommentHtml('# Not a heading\n\n<h2>Also not one</h2>')
    assert.ok(!/<h[1-6][\s>]/.test(html))
  })

  test('allows no images, so a comment cannot carry a tracking pixel', () => {
    const html = renderCommentHtml('<img src="https://tracker.example/p.gif">')
    assert.ok(!html.includes('<img'))
  })

  test('blank lines become separate paragraphs', () => {
    const html = renderCommentHtml('First thought.\n\nSecond thought.')
    assert.equal((html.match(/<p>/g) ?? []).length, 2)
  })

  test('single newlines become line breaks, not new paragraphs', () => {
    const html = renderCommentHtml('Line one\nLine two')
    assert.equal((html.match(/<p>/g) ?? []).length, 1)
    assert.ok(html.includes('<br'))
  })

  test('shortens a long URL for display but links it in full', () => {
    const long = `https://example.com/${'segment/'.repeat(12)}end`
    const html = renderCommentHtml(long)

    assert.ok(html.includes(`href="${long}"`), 'the href keeps the whole URL')
    assert.ok(html.includes('…'), 'the visible text is truncated')
  })

  test('encodes ampersands in a query string correctly', () => {
    const html = renderCommentHtml('https://example.com/a?x=1&y=2')
    // `&amp;` is the correct attribute encoding; a raw `&` would be invalid.
    assert.ok(html.includes('href="https://example.com/a?x=1&amp;y=2"'))
  })

  test('an empty body produces no markup', () => {
    assert.equal(renderCommentHtml('   \n\n  '), '')
  })
})
