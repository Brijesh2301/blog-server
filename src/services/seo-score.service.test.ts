import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { scorePost, type SeoInput, type SeoReport } from './seo-score.service.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * SEO SCORER
 * ═════════════════════════════════════════════════════════════════════════════
 * This function is not advisory. The same report that renders the editor panel
 * also gates publishing, so a wrong answer here either blocks a valid article
 * or lets a broken one onto the site.
 *
 * The regression it exists for: the HTML checks only matched DOUBLE-quoted
 * attributes. An editor that emitted `href='…'` or `alt='…'` — which is valid
 * HTML, and which several sanitisers produce — made the scorer report zero
 * internal links and flag fully-described images as missing alt text. The
 * second one is the dangerous half, because `cover-alt` and `body-image-alt`
 * are blocking checks, so correct markup was refused publication.
 */

function body(inner: string, repeat = 0): string {
  // Padding, so word-count checks do not drown the signal under test.
  const filler = '<p>Some perfectly ordinary prose about the subject at hand.</p>'
  return inner + filler.repeat(repeat)
}

function find(report: SeoReport, id: string) {
  const check = report.checks.find((c) => c.id === id)
  assert.ok(check, `expected a check with id "${id}"`)
  return check
}

const base: SeoInput = {
  title: 'Why server components changed where the work happens',
  metaDescription:
    'A worked guide to server components: how to measure the change, the one adjustment that usually matters, and the trade-off that nobody mentions.',
  slug: 'why-server-components-changed-where-the-work-happens',
  excerpt: 'A worked guide to server components and where the work actually happens now.',
  focusKeyword: 'server components',
  coverImageUrl: 'https://cdn.example.com/cover.png',
  coverImageAlt: 'A diagram of where rendering work happens',
  categoryId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  tagCount: 4,
}

describe('attribute quoting', () => {
  test('counts internal links written with single quotes', () => {
    const double = scorePost({
      ...base,
      contentHtml: body('<a href="/blog/other">x</a>'),
    })
    const single = scorePost({
      ...base,
      contentHtml: body("<a href='/blog/other'>x</a>"),
    })

    assert.equal(
      find(single, 'internal-links').status,
      find(double, 'internal-links').status,
      'single-quoted href must count the same as double-quoted'
    )
  })

  test('counts an unquoted href', () => {
    // Bare `href=/blog/other` is legal HTML too, and some editors emit it.
    const report = scorePost({ ...base, contentHtml: body('<a href=/blog/other>x</a>') })
    assert.notEqual(find(report, 'internal-links').status, 'fail')
  })

  test('counts external links written with single quotes', () => {
    const html = "<a href='https://example.com/ref'>source</a>"
    const report = scorePost({ ...base, contentHtml: body(html) })

    assert.notEqual(
      find(report, 'external-links').status,
      'fail',
      'a single-quoted external link must be seen'
    )
  })

  test('does not flag a single-quoted alt as missing', () => {
    // The dangerous half: this check is blocking, so a false negative refuses
    // to publish a correctly described image.
    const report = scorePost({
      ...base,
      contentHtml: body("<img src='/a.png' alt='A described diagram'>"),
    })

    assert.notEqual(find(report, 'body-image-alt').status, 'fail')
  })

  test('still catches a genuinely missing alt', () => {
    const report = scorePost({ ...base, contentHtml: body('<img src="/a.png">') })
    assert.equal(find(report, 'body-image-alt').status, 'fail')
  })

  test('still catches an empty alt on a content image', () => {
    const report = scorePost({ ...base, contentHtml: body('<img src="/a.png" alt="">') })
    assert.equal(find(report, 'body-image-alt').status, 'fail')
  })
})

describe('blocking checks', () => {
  test('a missing cover alt blocks publication', () => {
    const report = scorePost({ ...base, coverImageAlt: null, contentHtml: body('') })

    assert.ok(
      report.blockers.some((b) => b.id === 'cover-alt'),
      'cover-alt must appear in blockers'
    )
  })

  test('a complete post has no blockers', () => {
    const report = scorePost({
      ...base,
      contentHtml: body(
        '<h2>First section</h2><p>Body.</p><h3>Detail</h3>' +
          '<a href="/blog/other">internal</a>' +
          '<a href="https://example.com">external</a>' +
          '<img src="/a.png" alt="A described diagram">',
        40
      ),
    })

    assert.deepEqual(
      report.blockers.map((b) => b.id),
      [],
      `unexpected blockers: ${JSON.stringify(report.blockers.map((b) => b.id))}`
    )
  })

  test('every blocker is also present in checks', () => {
    const report = scorePost({ ...base, coverImageAlt: null, contentHtml: body('') })
    for (const blocker of report.blockers) {
      assert.ok(report.checks.some((c) => c.id === blocker.id))
    }
  })
})

describe('scoring', () => {
  test('the score stays within 0-100', () => {
    const inputs: SeoInput[] = [
      {},
      base,
      { ...base, contentHtml: body('<h2>x</h2>', 60) },
      { title: 'x'.repeat(300), focusKeyword: 'x' },
    ]

    for (const input of inputs) {
      const { score } = scorePost(input)
      assert.ok(score >= 0 && score <= 100, `score out of range: ${score}`)
      assert.ok(Number.isFinite(score))
    }
  })

  test('an empty post scores lower than a complete one', () => {
    const empty = scorePost({})
    const full = scorePost({ ...base, contentHtml: body('<h2>A section</h2>', 60) })

    assert.ok(full.score > empty.score, `${full.score} should beat ${empty.score}`)
  })

  test('keyword density is a finite number even with no content', () => {
    const report = scorePost({ focusKeyword: 'server components' })
    assert.ok(Number.isFinite(report.keywordDensity))
  })

  test('does not divide by zero on an empty body', () => {
    const report = scorePost({ ...base, contentHtml: '', contentText: '' })
    assert.equal(report.wordCount, 0)
    assert.ok(Number.isFinite(report.keywordDensity))
  })

  test('is deterministic', () => {
    const input = { ...base, contentHtml: body('<h2>A section</h2>', 10) }
    assert.equal(scorePost(input).score, scorePost(input).score)
  })
})

describe('keyword placement', () => {
  test('notices the focus keyword in the title', () => {
    const report = scorePost({ ...base, contentHtml: body('') })
    assert.equal(find(report, 'keyword-title').status, 'pass')
  })

  test('fails when the title does not contain the keyword', () => {
    const report = scorePost({
      ...base,
      title: 'An unrelated headline about something else entirely',
      metaTitle: null,
      contentHtml: body(''),
    })
    assert.notEqual(find(report, 'keyword-title').status, 'pass')
  })

  test('matches the keyword case-insensitively', () => {
    const report = scorePost({
      ...base,
      title: 'Why SERVER COMPONENTS changed where the work happens',
      contentHtml: body(''),
    })
    assert.equal(find(report, 'keyword-title').status, 'pass')
  })
})
