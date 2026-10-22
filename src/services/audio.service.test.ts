import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { audioHash, estimateDuration, toSpeechText } from './audio.service.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LISTEN — SPEECH TEXT AND HASHING
 * ═════════════════════════════════════════════════════════════════════════════
 * Two things here have real consequences.
 *
 * `toSpeechText` decides what a listener hears. Reading a code block aloud —
 * "less than p greater than const x equals use memo open paren" — is worse
 * than silence, so whole unlistenable blocks are removed rather than
 * flattened.
 *
 * `audioHash` decides what gets BILLED. It keys generated audio to the exact
 * text that was synthesised, so re-saving a post without touching its prose
 * never regenerates. If the hash were unstable, every autosave would be a
 * paid TTS call.
 */

describe('toSpeechText', () => {
  const article = {
    title: 'Why server components changed where the work happens',
    authorName: 'Priya Raman',
  }

  test('opens with the title and author as a spoken intro', () => {
    const text = toSpeechText({ ...article, contentHtml: '<p>Body text.</p>' })
    assert.ok(
      text.startsWith(
        'Why server components changed where the work happens. By Priya Raman.'
      )
    )
  })

  test('omits the byline when there is no author', () => {
    const text = toSpeechText({
      title: 'A title',
      authorName: null,
      contentHtml: '<p>Body.</p>',
    })
    assert.ok(text.startsWith('A title.'))
    assert.ok(!text.includes('By '))
  })

  test('removes code blocks entirely', () => {
    const text = toSpeechText({
      ...article,
      contentHtml:
        '<p>Before.</p><pre><code>const x = useMemo(() => 1)</code></pre><p>After.</p>',
    })

    assert.ok(!text.includes('useMemo'))
    assert.ok(text.includes('Before'))
    assert.ok(text.includes('After'))
  })

  test('removes inline code', () => {
    const text = toSpeechText({
      ...article,
      contentHtml: '<p>Call <code>revalidateTag</code> afterwards.</p>',
    })
    assert.ok(!text.includes('revalidateTag'))
  })

  test('removes tables, which have no spoken form', () => {
    const text = toSpeechText({
      ...article,
      contentHtml: '<p>Before.</p><table><tr><td>cell</td></tr></table><p>After.</p>',
    })
    assert.ok(!text.includes('cell'))
  })

  test('removes bare URLs, which read as a stream of letters', () => {
    const text = toSpeechText({
      ...article,
      contentHtml: '<p>See https://example.com/a/b?c=1 for more.</p>',
    })
    assert.ok(!text.includes('http'))
    assert.ok(text.includes('See'))
  })

  test('gives a heading terminal punctuation so it does not run on', () => {
    const text = toSpeechText({
      ...article,
      contentHtml: '<h2>The trade-off</h2><p>It costs more up front.</p>',
    })
    assert.match(text, /The trade-off\.\s+It costs more up front\./)
  })

  test('decodes entities rather than speaking them', () => {
    const text = toSpeechText({
      ...article,
      contentHtml: '<p>Caching &amp; invalidation &mdash; the hard parts.</p>',
    })

    assert.ok(text.includes('Caching & invalidation'))
    assert.ok(!text.includes('&amp;'))
    assert.ok(!text.includes('&mdash;'))
  })

  test('collapses the ". . ." runs that tag-stripping leaves behind', () => {
    const text = toSpeechText({
      ...article,
      contentHtml: '<p>One.</p><p></p><li></li><p>Two.</p>',
    })
    assert.ok(!/\.\s*\.\s*\./.test(text), `found a run of stops in: ${text}`)
  })

  test('survives a null body', () => {
    const text = toSpeechText({ ...article, contentHtml: null })
    assert.ok(text.length > 0)
  })

  test('leaves no HTML tags behind', () => {
    const text = toSpeechText({
      ...article,
      contentHtml: '<p>A <strong>bold</strong> and <em>italic</em> sentence.</p>',
    })
    assert.ok(!text.includes('<'))
    assert.ok(text.includes('bold'))
  })
})

describe('audioHash', () => {
  test('is stable for identical text and voice', () => {
    assert.equal(audioHash('hello world', 'alloy'), audioHash('hello world', 'alloy'))
  })

  test('changes when the text changes', () => {
    assert.notEqual(audioHash('hello world', 'alloy'), audioHash('hello there', 'alloy'))
  })

  test('changes when the voice changes', () => {
    // Otherwise switching voice would serve the old voice's file forever.
    assert.notEqual(audioHash('hello world', 'alloy'), audioHash('hello world', 'nova'))
  })

  test('cannot be collided by moving the separator into the voice name', () => {
    // A naive `voice + text` concatenation makes ("a::b", "c") and ("a", "b::c")
    // hash identically.
    assert.notEqual(audioHash('b::c', 'a'), audioHash('c', 'a::b'))
  })
})

describe('estimateDuration', () => {
  test('is at least one second for any text', () => {
    assert.ok(estimateDuration('') >= 1)
    assert.ok(estimateDuration('one') >= 1)
  })

  test('scales with word count', () => {
    const short = estimateDuration('word '.repeat(150))
    const long = estimateDuration('word '.repeat(300))
    assert.ok(long > short)
  })

  test('uses a speaking pace of roughly 150 wpm', () => {
    // 150 words should land near 60 seconds; a wide band, because the exact
    // figure matters less than it not being wrong by an order of magnitude.
    const seconds = estimateDuration('word '.repeat(150))
    assert.ok(seconds > 50 && seconds < 70, `got ${seconds}s`)
  })
})
