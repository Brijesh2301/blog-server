import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createPostSchema, updatePostSchema } from './post.schema.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * POST SCHEMA — the unpublish regression
 * ═════════════════════════════════════════════════════════════════════════════
 * The most severe bug in the project so far, and this file exists to make sure
 * it cannot come back.
 *
 * `status` carried `.default('draft')` on the shared base object. Zod's
 * `.partial()` makes keys OPTIONAL but does NOT strip defaults — so every
 * PATCH that omitted `status` had `status: 'draft'` injected into it, and the
 * service dutifully unpublished a live article because someone fixed a typo in
 * its meta description.
 *
 * It fails silently: 200 OK, a valid-looking response, and the post vanishes
 * from the site. The default now lives in `createPostSchema` alone.
 */

/** A body that satisfies the publish checklist. */
const publishable = {
  title: 'A sufficiently long and specific title',
  excerpt:
    'An excerpt comfortably past the fifty character minimum that the publish checklist enforces.',
  coverImageUrl: 'https://cdn.example.com/cover.png',
  coverImageAlt: 'A descriptive alt text',
  categoryId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  focusKeyword: 'server components',
  metaDescription:
    'A meta description written deliberately to sit well inside the 140 to 160 character budget that Google renders in a search result before truncating.',
}

describe('updatePostSchema', () => {
  test('does NOT inject a status default into a partial update', () => {
    const parsed = updatePostSchema.parse({ metaTitle: 'Only this changed' })

    assert.equal(
      'status' in parsed,
      false,
      'a PATCH that omits status must not acquire one — this unpublishes live posts'
    )
  })

  test('leaves every other omitted key absent too', () => {
    const parsed = updatePostSchema.parse({ title: 'Just the title' })

    assert.deepEqual(Object.keys(parsed), ['title'])
  })

  test('still accepts an explicit status', () => {
    const parsed = updatePostSchema.parse({ status: 'archived' })
    assert.equal(parsed.status, 'archived')
  })

  test('rejects an unknown status', () => {
    assert.equal(updatePostSchema.safeParse({ status: 'live' }).success, false)
  })

  test('does not run the publish checklist on a partial update', () => {
    // A PATCH touching one field must not be rejected for fields it never
    // mentioned; the service re-runs the checklist against the merged row.
    assert.equal(updatePostSchema.safeParse({ status: 'published' }).success, true)
  })
})

describe('createPostSchema', () => {
  test('defaults status to draft when omitted', () => {
    const parsed = createPostSchema.parse({ title: 'A brand new post' })
    assert.equal(parsed.status, 'draft')
  })

  test('accepts a complete publishable post', () => {
    const result = createPostSchema.safeParse({ ...publishable, status: 'published' })
    assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  })

  test('refuses to publish without a cover image', () => {
    const { coverImageUrl, ...rest } = publishable
    void coverImageUrl
    const result = createPostSchema.safeParse({ ...rest, status: 'published' })

    assert.equal(result.success, false)
    assert.ok(result.error?.issues.some((i) => i.path[0] === 'coverImageUrl'))
  })

  test('refuses to publish without cover alt text', () => {
    const { coverImageAlt, ...rest } = publishable
    void coverImageAlt
    const result = createPostSchema.safeParse({ ...rest, status: 'published' })

    assert.equal(result.success, false)
    assert.ok(result.error?.issues.some((i) => i.path[0] === 'coverImageAlt'))
  })

  test('refuses to publish without a focus keyword', () => {
    const { focusKeyword, ...rest } = publishable
    void focusKeyword
    const result = createPostSchema.safeParse({ ...rest, status: 'published' })

    assert.equal(result.success, false)
    assert.ok(result.error?.issues.some((i) => i.path[0] === 'focusKeyword'))
  })

  test('refuses to publish with a too-short meta description', () => {
    const result = createPostSchema.safeParse({
      ...publishable,
      metaDescription: 'Too short.',
      status: 'published',
    })

    assert.equal(result.success, false)
    assert.ok(result.error?.issues.some((i) => i.path[0] === 'metaDescription'))
  })

  test('applies the SAME checklist to a scheduled post', () => {
    // Scheduling is publishing with a delay; letting it skip the checklist
    // would just move the problem to the moment the scheduler fires.
    const { focusKeyword, ...rest } = publishable
    void focusKeyword
    const result = createPostSchema.safeParse({
      ...rest,
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    })

    assert.equal(result.success, false)
    assert.ok(result.error?.issues.some((i) => i.path[0] === 'focusKeyword'))
  })

  test('refuses a scheduled time in the past', () => {
    const result = createPostSchema.safeParse({
      ...publishable,
      status: 'scheduled',
      scheduledFor: new Date(Date.now() - 86_400_000).toISOString(),
    })

    assert.equal(result.success, false)
    assert.ok(result.error?.issues.some((i) => i.path[0] === 'scheduledFor'))
  })

  test('lets a draft skip the whole checklist', () => {
    assert.equal(createPostSchema.safeParse({ title: 'Work in progress' }).success, true)
  })

  test('rejects a slug with uppercase or spaces', () => {
    for (const slug of ['Not A Slug', 'UPPER', 'double--hyphen', '-leading']) {
      assert.equal(
        createPostSchema.safeParse({ title: 'A post', slug }).success,
        false,
        `"${slug}" should be rejected`
      )
    }
  })

  test('caps tags at twelve', () => {
    const tagIds = Array.from(
      { length: 13 },
      () => '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    )
    assert.equal(createPostSchema.safeParse({ title: 'A post', tagIds }).success, false)
  })
})
