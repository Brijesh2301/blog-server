import { sql } from 'drizzle-orm'

import { closeDatabase, db } from '../db/index.js'
import { categories, postTags, posts, series, tags, users } from '../db/schema.js'
import { hashPassword } from '../lib/password.js'
import { slugify } from '../lib/slug.js'
import { logger } from '../utils/logger.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * SEED
 * ═════════════════════════════════════════════════════════════════════════════
 * Creates a realistic working dataset: 3 authors, 8 categories, 14 tags,
 * 2 series and 15 published posts with full SEO metadata.
 *
 * Idempotent — every insert is `onConflictDoNothing` against a unique slug or
 * email, so re-running adds nothing and never throws. That matters because
 * this runs in local setup and in CI.
 *
 * The copy is deliberately real prose rather than lorem ipsum: the design gate
 * depends on seeing true line lengths, excerpt wrapping and card heights.
 */

const DEV_PASSWORD = 'devlume-local-dev-password'

/**
 * Typed explicitly: the three entries have different `socials` keys, so
 * inference widens the field to a union of object literals and drizzle's
 * single-row `.values()` overload stops matching.
 */
type SeedAuthor = {
  name: string
  email: string
  role: 'admin' | 'editor' | 'author'
  jobTitle: string
  credentials: string
  bio: string
  knowsAbout: string[]
  socials: Record<string, string>
}

const AUTHORS: SeedAuthor[] = [
  {
    name: 'Priya Raman',
    email: 'priya@devlume.dev',
    role: 'admin' as const,
    jobTitle: 'Editor-in-chief',
    credentials:
      'Twelve years building rendering pipelines; previously staff engineer on a top-500 commerce site.',
    bio: 'Priya writes about rendering, caching and the places the two collide. She has spent most of a decade making large sites fast and is still annoyed by layout shift.',
    knowsAbout: ['Web performance', 'Rendering', 'Next.js', 'Core Web Vitals'],
    socials: { x: 'https://x.com/devlume', github: 'https://github.com/devlume' },
  },
  {
    name: 'Marcus Hale',
    email: 'marcus@devlume.dev',
    role: 'editor' as const,
    jobTitle: 'Senior editor, systems',
    credentials:
      'Former SRE; ran Postgres fleets through three orders of magnitude of growth.',
    bio: 'Marcus covers databases, queues and the unglamorous infrastructure that decides whether a product survives its own success.',
    knowsAbout: ['PostgreSQL', 'Distributed systems', 'Observability', 'Node.js'],
    socials: { github: 'https://github.com/devlume' },
  },
  {
    name: 'Ayo Bankole',
    email: 'ayo@devlume.dev',
    role: 'author' as const,
    jobTitle: 'AI engineering lead',
    credentials:
      'Shipped three production RAG systems; writes evaluation harnesses for a living.',
    bio: 'Ayo works on LLM applications that have to survive contact with real users, and is sceptical of every benchmark including his own.',
    knowsAbout: ['LLM applications', 'RAG', 'Evaluation', 'TypeScript'],
    socials: { x: 'https://x.com/devlume' },
  },
]

const CATEGORIES = [
  {
    name: 'Web Development',
    tone: 'text-brand-700 bg-brand-100 dark:text-brand-200 dark:bg-brand-500/15',
    icon: 'Code',
    featured: true,
    description: 'Next.js, React, routing, rendering and the modern browser.',
    introText:
      'The browser changed more in the last three years than in the decade before it. Server components moved rendering back to the server, view transitions made navigation feel native, and the platform quietly absorbed half of what we used libraries for. These guides cover what actually changed, what it costs, and when the old approach is still the right one.',
  },
  {
    name: 'AI Engineering',
    tone: 'text-accent-800 bg-accent-100 dark:text-accent-200 dark:bg-accent-500/15',
    icon: 'Bot',
    featured: true,
    description: 'LLM apps, RAG pipelines, evals and agent architecture.',
    introText:
      'Most writing about LLM applications stops at the demo. These guides pick up where the demo ends: retrieval that holds up on real corpora, evaluation harnesses that catch regressions before users do, and the cost and latency trade-offs nobody mentions in the launch post.',
  },
  {
    name: 'TypeScript',
    tone: 'text-brand-700 bg-brand-100 dark:text-brand-200 dark:bg-brand-500/15',
    icon: 'Layers',
    description: 'Types that catch real bugs, and the patterns behind them.',
    introText:
      'A type system earns its keep when it catches bugs you would otherwise ship, and costs you when it catches things that were never going to break. These guides are about telling the two apart.',
  },
  {
    name: 'Performance',
    tone: 'text-warm-800 bg-warm-100 dark:text-warm-200 dark:bg-warm-500/15',
    icon: 'Gauge',
    featured: true,
    description: 'Core Web Vitals, bundle budgets and render profiling.',
    introText:
      'Performance work fails when it starts with a guess. Every guide here starts with a measurement, changes exactly one thing, and measures again — because the alternative is a week of refactoring that moves the number by nothing.',
  },
  {
    name: 'Backend & Infra',
    tone: 'text-accent-800 bg-accent-100 dark:text-accent-200 dark:bg-accent-500/15',
    icon: 'Terminal',
    description: 'Node, Postgres, queues, caching and deployment.',
    introText:
      'The backend is where the trade-offs get expensive and irreversible. These guides cover schema decisions you will live with for years, the queue semantics that decide whether you lose data, and the deployment choices that determine how bad a bad night gets.',
  },
  {
    name: 'Systems Design',
    tone: 'text-brand-700 bg-brand-100 dark:text-brand-200 dark:bg-brand-500/15',
    icon: 'Cpu',
    description: 'Trade-offs, scaling patterns and architecture reviews.',
    introText:
      'Architecture is the set of decisions that are expensive to reverse. These guides walk real systems, name the constraint each decision was serving, and are honest about which ones aged badly.',
  },
  {
    name: 'Security',
    tone: 'text-warm-800 bg-warm-100 dark:text-warm-200 dark:bg-warm-500/15',
    icon: 'ShieldCheck',
    description: 'Auth, secrets, supply chain and practical hardening.',
    introText:
      'Security guidance is usually either a compliance checklist or a conference talk about an attack you will never face. These guides aim at the middle: the handful of controls that actually change your risk, explained well enough to implement correctly.',
  },
  {
    name: 'Developer Tooling',
    tone: 'text-accent-800 bg-accent-100 dark:text-accent-200 dark:bg-accent-500/15',
    icon: 'Sparkles',
    description: 'Editors, CLIs, CI and the loop you live in all day.',
    introText:
      'You spend more time in your tools than in any codebase. These guides cover the edit-run-verify loop: making it faster, making it quieter, and knowing when a tool is costing more attention than it saves.',
  },
]

const TAG_NAMES = [
  'Next.js',
  'React',
  'TypeScript',
  'PostgreSQL',
  'Caching',
  'Testing',
  'RAG',
  'Evaluation',
  'Core Web Vitals',
  'Docker',
  'CI/CD',
  'Auth',
  'Observability',
  'Node.js',
]

const SERIES = [
  {
    title: 'Rendering, end to end',
    description:
      'A six-part walk from the request hitting the edge to the last pixel painting, and every cache in between.',
  },
  {
    title: 'Shipping LLM features',
    description:
      'What it takes to move an LLM feature from a convincing demo to something you are willing to page someone about.',
  },
]

/** 15 posts. Each carries the full SEO field set the publish checklist needs. */
const POSTS = [
  {
    title: 'Why Server Components changed where the work happens',
    category: 'Web Development',
    author: 0,
    keyword: 'react server components',
    tags: ['Next.js', 'React'],
    featured: true,
    editorsPick: true,
    series: 0,
    pos: 1,
  },
  {
    title: 'The caching model behind Next.js, explained properly',
    category: 'Web Development',
    author: 0,
    keyword: 'next.js caching',
    tags: ['Next.js', 'Caching'],
    featured: true,
    series: 0,
    pos: 2,
  },
  {
    title: 'Core Web Vitals: what actually moves LCP',
    category: 'Performance',
    author: 0,
    keyword: 'core web vitals lcp',
    tags: ['Core Web Vitals', 'Next.js'],
    featured: true,
    editorsPick: true,
  },
  {
    title: 'Cumulative Layout Shift is a layout bug, not a metric',
    category: 'Performance',
    author: 0,
    keyword: 'cumulative layout shift',
    tags: ['Core Web Vitals'],
  },
  {
    title: 'A bundle budget you will actually keep',
    category: 'Performance',
    author: 0,
    keyword: 'javascript bundle size',
    tags: ['Next.js', 'CI/CD'],
  },
  {
    title: 'Retrieval that survives a real corpus',
    category: 'AI Engineering',
    author: 2,
    keyword: 'rag architecture',
    tags: ['RAG'],
    editorsPick: true,
    series: 1,
    pos: 1,
  },
  {
    title: 'Writing evals before you write the prompt',
    category: 'AI Engineering',
    author: 2,
    keyword: 'llm evaluation',
    tags: ['Evaluation', 'Testing'],
    series: 1,
    pos: 2,
  },
  {
    title: 'The cost model of an LLM feature',
    category: 'AI Engineering',
    author: 2,
    keyword: 'llm application cost',
    tags: ['RAG', 'Evaluation'],
  },
  {
    title: 'Discriminated unions are the pattern you are missing',
    category: 'TypeScript',
    author: 2,
    keyword: 'typescript discriminated unions',
    tags: ['TypeScript'],
  },
  {
    title: 'Stop fighting the type system at the boundary',
    category: 'TypeScript',
    author: 2,
    keyword: 'typescript validation',
    tags: ['TypeScript', 'Testing'],
  },
  {
    title: 'Postgres indexes: the five that cover almost everything',
    category: 'Backend & Infra',
    author: 1,
    keyword: 'postgresql index types',
    tags: ['PostgreSQL'],
    featured: true,
  },
  {
    title: 'Full-text search in Postgres, without the second database',
    category: 'Backend & Infra',
    author: 1,
    keyword: 'postgres full text search',
    tags: ['PostgreSQL', 'Caching'],
    editorsPick: true,
  },
  {
    title: 'Queues lose messages. Design for it.',
    category: 'Systems Design',
    author: 1,
    keyword: 'message queue reliability',
    tags: ['Node.js', 'Observability'],
  },
  {
    title: 'Refresh token rotation, and the attack it stops',
    category: 'Security',
    author: 1,
    keyword: 'refresh token rotation',
    tags: ['Auth', 'Node.js'],
  },
  {
    title: 'A CI pipeline that fails for the right reasons',
    category: 'Developer Tooling',
    author: 1,
    keyword: 'ci cd pipeline',
    tags: ['CI/CD', 'Docker', 'Testing'],
  },
]

function buildBody(title: string, keyword: string): { html: string; text: string } {
  const paragraphs = [
    `${title.replace(/^(Why|The|A|Stop|Writing|Queues) /, (m) => m)} is one of those topics where the summary everyone repeats is almost right, and the gap between almost and actually is where the production incidents live. This guide works through ${keyword} from the measurement up.`,
    `The short version: the default is usually fine, the failure mode is specific, and the fix is cheaper than the rewrite people reach for. What follows is the reasoning, with the numbers that produced it.`,
    `Start by reproducing the problem in isolation. A benchmark that includes your whole application measures your whole application, and you will spend a day chasing a number that moves for reasons unrelated to the change you are testing.`,
    `Once the measurement is stable, change exactly one thing. The discipline sounds obvious and is almost never followed, because changing three things and seeing the number improve feels like progress. It is not progress; it is three untested hypotheses and no information about which one mattered.`,
    `The trade-off worth naming explicitly: this approach costs more up front and less every time afterwards. If you are shipping once, ignore all of it. If you are maintaining this for two years, it pays for itself within the first month.`,
  ]
  const text = paragraphs.join('\n\n')
  const html = [
    `<p>${paragraphs[0]}</p>`,
    `<h2 id="the-short-version">The short version</h2>`,
    `<p>${paragraphs[1]}</p>`,
    `<h2 id="reproduce-it-first">Reproduce it first</h2>`,
    `<p>${paragraphs[2]}</p>`,
    `<p>${paragraphs[3]}</p>`,
    `<h2 id="the-trade-off">The trade-off</h2>`,
    `<p>${paragraphs[4]}</p>`,
  ].join('\n')
  return { html, text }
}

async function main() {
  logger.info('seeding...')

  // ── Authors ───────────────────────────────────────────────────────────────
  const passwordHash = await hashPassword(DEV_PASSWORD)
  const authorIds: string[] = []

  for (const author of AUTHORS) {
    const [row] = await db
      .insert(users)
      .values({
        name: author.name,
        email: author.email,
        slug: slugify(author.name),
        passwordHash,
        role: author.role,
        bio: author.bio,
        jobTitle: author.jobTitle,
        credentials: author.credentials,
        knowsAbout: author.knowsAbout,
        socials: author.socials,
        emailVerifiedAt: new Date(),
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id })

    if (row) {
      authorIds.push(row.id)
    } else {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.email} = ${author.email}`)
        .limit(1)
      if (existing) authorIds.push(existing.id)
    }
  }

  // ── Categories ────────────────────────────────────────────────────────────
  const categoryIds = new Map<string, string>()
  for (const [i, category] of CATEGORIES.entries()) {
    const slug = slugify(category.name)
    const [row] = await db
      .insert(categories)
      .values({
        name: category.name,
        slug,
        description: category.description,
        introText: category.introText,
        tone: category.tone,
        icon: category.icon,
        featured: category.featured ?? false,
        position: i,
        metaTitle: `${category.name} guides`,
        metaDescription: category.description,
      })
      .onConflictDoNothing({ target: categories.slug })
      .returning({ id: categories.id })

    const id =
      row?.id ??
      (
        await db
          .select({ id: categories.id })
          .from(categories)
          .where(sql`${categories.slug} = ${slug}`)
          .limit(1)
      )[0]?.id

    if (id) categoryIds.set(category.name, id)
  }

  // ── Tags ──────────────────────────────────────────────────────────────────
  const tagIds = new Map<string, string>()
  for (const name of TAG_NAMES) {
    const slug = slugify(name)
    const [row] = await db
      .insert(tags)
      .values({ name, slug })
      .onConflictDoNothing({ target: tags.slug })
      .returning({ id: tags.id })

    const id =
      row?.id ??
      (
        await db
          .select({ id: tags.id })
          .from(tags)
          .where(sql`${tags.slug} = ${slug}`)
          .limit(1)
      )[0]?.id

    if (id) tagIds.set(name, id)
  }

  // ── Series ────────────────────────────────────────────────────────────────
  const seriesIds: string[] = []
  for (const item of SERIES) {
    const slug = slugify(item.title)
    const [row] = await db
      .insert(series)
      .values({ title: item.title, slug, description: item.description })
      .onConflictDoNothing({ target: series.slug })
      .returning({ id: series.id })

    const id =
      row?.id ??
      (
        await db
          .select({ id: series.id })
          .from(series)
          .where(sql`${series.slug} = ${slug}`)
          .limit(1)
      )[0]?.id

    if (id) seriesIds.push(id)
  }

  // ── Posts ─────────────────────────────────────────────────────────────────
  let created = 0
  for (const [i, spec] of POSTS.entries()) {
    const slug = slugify(spec.title)
    const { html, text } = buildBody(spec.title, spec.keyword)
    const words = text.split(/\s+/).length

    // Spread publication dates backwards so listings have a believable order.
    const publishedAt = new Date(Date.now() - (i + 1) * 3 * 24 * 60 * 60 * 1000)

    const excerpt = `A worked guide to ${spec.keyword}: how to measure it, the one change that usually matters, and the trade-off nobody mentions.`

    const [row] = await db
      .insert(posts)
      .values({
        slug,
        title: spec.title,
        subtitle: null,
        excerpt,
        contentHtml: html,
        contentText: text,
        coverImageUrl: `https://res.cloudinary.com/demo/image/upload/w_1200,h_630,c_fill/sample.jpg`,
        coverImageAlt: `Illustration for ${spec.title}`,
        status: 'published',
        authorId: authorIds[spec.author % authorIds.length]!,
        categoryId: categoryIds.get(spec.category) ?? null,
        seriesId: spec.series !== undefined ? (seriesIds[spec.series] ?? null) : null,
        seriesPosition: spec.pos ?? null,
        metaTitle: spec.title.slice(0, 70),
        metaDescription: excerpt.slice(0, 160),
        focusKeyword: spec.keyword,
        featured: spec.featured ?? false,
        editorsPick: spec.editorsPick ?? false,
        wordCount: words,
        readingMinutes: Math.max(1, Math.round(words / 225)),
        viewCount: Math.floor(Math.random() * 4000) + 120,
        publishedAt,
        reviewedAt: publishedAt,
      })
      .onConflictDoNothing({ target: posts.slug })
      .returning({ id: posts.id })

    if (!row) continue
    created++

    const ids = spec.tags.map((t) => tagIds.get(t)).filter((v): v is string => Boolean(v))
    if (ids.length) {
      await db
        .insert(postTags)
        .values(ids.map((tagId) => ({ postId: row.id, tagId })))
        .onConflictDoNothing()
    }
  }

  // Counters are recomputed rather than incremented, so a partial seed run
  // still leaves them correct.
  await db.update(categories).set({
    postCount: sql`(SELECT count(*)::int FROM ${posts} WHERE ${posts.categoryId} = ${categories.id} AND ${posts.status} = 'published')`,
  })
  await db.update(tags).set({
    postCount: sql`(SELECT count(*)::int FROM ${postTags} JOIN ${posts} ON ${posts.id} = ${postTags.postId} WHERE ${postTags.tagId} = ${tags.id} AND ${posts.status} = 'published')`,
  })
  await db.update(series).set({
    postCount: sql`(SELECT count(*)::int FROM ${posts} WHERE ${posts.seriesId} = ${series.id} AND ${posts.status} = 'published')`,
  })

  logger.info(
    {
      authors: authorIds.length,
      categories: categoryIds.size,
      tags: tagIds.size,
      series: seriesIds.length,
      postsCreated: created,
    },
    'seed complete'
  )
  logger.info(`sign in with ${AUTHORS[0]!.email} / ${DEV_PASSWORD}  (development only)`)
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'seed failed')
    process.exitCode = 1
  })
  .finally(() => closeDatabase())
