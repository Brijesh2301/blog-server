import { and, eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { posts } from '../db/schema.js'
import { logger } from '../utils/logger.js'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * HINDI TRANSLATIONS
 * ═════════════════════════════════════════════════════════════════════════════
 * Real translations of three seeded English articles, so `/hi/blog` is a
 * working Hindi blog rather than an empty shell.
 *
 * WHY ONLY THREE, AND WHY HAND-WRITTEN
 * A translation is a row someone WROTE. Running fifteen technical essays
 * through machine translation would fill the listing and produce Hindi that a
 * Hindi-speaking engineer would find harder to read than the English — which
 * is worse than having nothing there, because it also teaches Google that this
 * site publishes low-quality Hindi.
 *
 * Three complete, carefully translated articles demonstrate the feature end to
 * end: locale filtering, the translation link, hreflang pairs, and the
 * switcher offering a real link instead of "not available yet".
 *
 * TERMINOLOGY
 * Established English technical terms are kept in English — "server
 * components", "cache", "LCP". Hindi-speaking developers use those words; a
 * formal Sanskritised coinage would be unrecognisable. Prose around them is
 * fully translated. That is a judgement made per term, not a blanket rule.
 *
 * Run with: npx tsx src/scripts/seed-hindi.ts
 */

type Translation = {
  /** The English slug this translates. The Hindi row reuses it. */
  sourceSlug: string
  title: string
  subtitle: string
  excerpt: string
  metaDescription: string
  focusKeyword: string
  bodyHtml: string
}

const TRANSLATIONS: Translation[] = [
  {
    sourceSlug: 'why-server-components-changed-where-the-work-happens',
    title: 'Server Components ने काम की जगह क्यों बदल दी',
    subtitle: 'रेंडरिंग कहाँ होती है, और यह क्यों मायने रखता है',
    excerpt:
      'Server Components पर एक व्यावहारिक गाइड: इन्हें मापें कैसे, वह एक बदलाव जो आमतौर पर सबसे ज़्यादा असर करता है, और वह समझौता जिसका ज़िक्र कोई नहीं करता।',
    metaDescription:
      'Server Components पर एक व्यावहारिक गाइड — रेंडरिंग कहाँ होती है, इसे मापें कैसे, और वह एक बदलाव जो आपके bundle पर सबसे ज़्यादा असर डालता है।',
    focusKeyword: 'server components',
    bodyHtml: `
      <p>सालों तक हमने एक ही मॉडल मान कर चला: सर्वर HTML भेजता है, ब्राउज़र उसे हाइड्रेट करता है, और उसके बाद सब कुछ क्लाइंट पर होता है। Server Components इस धारणा को तोड़ते हैं — और सवाल यह नहीं है कि वे "तेज़" हैं या नहीं, बल्कि यह कि <strong>काम होता कहाँ है</strong>।</p>

      <h2>असली बदलाव bundle में है</h2>
      <p>जब कोई कंपोनेंट सर्वर पर चलता है, तो उसका कोड ब्राउज़र तक पहुँचता ही नहीं। एक markdown पार्सर, एक date लाइब्रेरी, एक syntax highlighter — ये सब सर्वर पर रह जाते हैं। पाठक के पास सिर्फ़ नतीजा पहुँचता है।</p>
      <p>यही वह जगह है जहाँ सबसे बड़ा फ़र्क़ दिखता है। हमारे अपने माप में एक आर्टिकल पेज का JavaScript लगभग एक-तिहाई रह गया, और वह कमी किसी चतुर optimisation से नहीं आई — वह कोड बस भेजा ही नहीं गया।</p>

      <h2>वह समझौता जिसका ज़िक्र कोई नहीं करता</h2>
      <p>Server Components में state नहीं होती, effects नहीं होते, और browser API तक पहुँच नहीं होती। यह सीमा नहीं, परिभाषा है। दिक़्क़त तब आती है जब आप एक मौजूदा कंपोनेंट को सर्वर पर ले जाना चाहते हैं और पाते हैं कि उसके भीतर कहीं गहराई में एक <code>useState</code> बैठा है।</p>
      <p>व्यवहार में इसका मतलब है कि सीमा-रेखा खींचनी पड़ती है: इंटरैक्टिव हिस्से क्लाइंट पर, बाक़ी सब सर्वर पर। वह रेखा सही जगह खींचना ही असली काम है।</p>

      <h2>इसे मापें कैसे</h2>
      <p>अनुमान मत लगाइए। DevTools में Coverage टैब खोलिए और देखिए कि लोड हुए JavaScript का कितना हिस्सा वाक़ई चला। अगर एक आर्टिकल पेज पर 60% कोड कभी नहीं चलता, तो वह कोड शायद सर्वर पर होना चाहिए।</p>
      <p>दूसरा माप सीधा है: throttled connection पर LCP। Slow 4G और 4× CPU throttling के साथ नापिए — localhost पर लिया गया कोई भी आँकड़ा असली पाठक के बारे में कुछ नहीं बताता।</p>

      <h2>निष्कर्ष</h2>
      <p>Server Components कोई जादू नहीं हैं। वे एक सवाल का जवाब हैं जो हमने लंबे समय से पूछना बंद कर दिया था — यह कोड ब्राउज़र में चल ही क्यों रहा है? अक्सर इसका कोई अच्छा जवाब नहीं होता, और तभी यह बदलाव सबसे ज़्यादा काम आता है।</p>
    `,
  },
  {
    sourceSlug: 'core-web-vitals-what-actually-moves-lcp',
    title: 'Core Web Vitals: LCP को असल में क्या हिलाता है',
    subtitle: 'मापा गया, अनुमान नहीं लगाया गया',
    excerpt:
      'LCP सुधारने के अधिकांश सुझाव कुछ नहीं करते। यह लेख बताता है कि वास्तव में किन चीज़ों से फ़र्क़ पड़ता है, और हर दावे के पीछे माप क्या है।',
    metaDescription:
      'LCP सुधारने के अधिकांश सुझाव कुछ नहीं करते। मापे गए नतीजों के साथ जानिए कि Largest Contentful Paint को असल में क्या बेहतर बनाता है।',
    focusKeyword: 'core web vitals',
    bodyHtml: `
      <p>LCP पर सलाह से इंटरनेट भरा पड़ा है, और उसका अधिकांश हिस्सा बेअसर है। समस्या यह नहीं कि सलाह ग़लत है — समस्या यह है कि वह आपके पेज पर लागू नहीं होती।</p>

      <h2>पहले यह पता कीजिए कि LCP element है क्या</h2>
      <p>यह पहला क़दम है और सबसे ज़्यादा छोड़ा जाने वाला। DevTools के Performance पैनल में LCP marker पर क्लिक कीजिए — वह आपको बता देगा कि कौन-सा element गिना जा रहा है। अक्सर वह वह नहीं होता जो आपने सोचा था।</p>
      <p>अगर वह एक इमेज है, तो काम इमेज पर है। अगर वह टेक्स्ट का एक ब्लॉक है, तो काम font loading और render-blocking CSS पर है। दोनों के समाधान अलग हैं, और ग़लत वाला लगाने से कुछ नहीं बदलता।</p>

      <h2>जो वाक़ई काम करता है</h2>
      <ul>
        <li><strong>LCP इमेज को priority दीजिए</strong> — और सिर्फ़ उसे। पेज पर पाँच इमेज को priority देना किसी की मदद नहीं करता; वे आपस में ही प्रतिस्पर्धा करती हैं।</li>
        <li><strong>सही आकार भेजिए।</strong> 2000px चौड़ी इमेज को 800px कंटेनर में दिखाना शुद्ध बर्बादी है।</li>
        <li><strong>फ़ॉन्ट self-host कीजिए</strong> और <code>display: swap</code> रखिए। किसी तीसरे होस्ट से फ़ॉन्ट लाना एक अतिरिक्त DNS lookup, TLS handshake और connection है — LCP से ठीक पहले।</li>
        <li><strong>TTFB घटाइए।</strong> LCP कभी TTFB से बेहतर नहीं हो सकता। अगर सर्वर 800ms लेता है, तो बाक़ी सब कुछ उसके ऊपर जुड़ता है।</li>
      </ul>

      <h2>जो आमतौर पर कुछ नहीं करता</h2>
      <p>हर चीज़ को <code>preload</code> करना। दर्जनों <code>preconnect</code> जोड़ना। JavaScript को और छोटे chunks में बाँटना जब LCP element एक इमेज है। ये बदलाव Lighthouse स्कोर हिला सकते हैं पर असली पाठक के अनुभव को नहीं।</p>

      <h2>लैब बनाम फ़ील्ड</h2>
      <p>Lighthouse एक परिकल्पना है; CrUX जवाब है। एक तेज़ लैपटॉप पर 95 का स्कोर उस पाठक के बारे में कुछ नहीं कहता जो तीन साल पुराने फ़ोन पर 3G से पढ़ रहा है। दोनों देखिए, पर भरोसा फ़ील्ड डेटा पर कीजिए।</p>
    `,
  },
  {
    sourceSlug: 'cumulative-layout-shift-is-a-layout-bug-not-a-metric',
    title: 'Cumulative Layout Shift एक layout बग है, metric नहीं',
    subtitle: 'इसे स्कोर की तरह नहीं, बग की तरह ठीक कीजिए',
    excerpt:
      'CLS को एक संख्या की तरह देखना इसे ठीक करना कठिन बना देता है। इसे उस चीज़ की तरह देखिए जो यह है — एक layout बग जिसकी हमेशा एक ठोस वजह होती है।',
    metaDescription:
      'CLS को एक स्कोर की तरह देखना इसे ठीक करना कठिन बना देता है। जानिए इसे layout बग की तरह कैसे पकड़ें और हर कारण को कैसे ख़त्म करें।',
    focusKeyword: 'cumulative layout shift',
    bodyHtml: `
      <p>CLS को लोग एक स्कोर की तरह देखते हैं जिसे "सुधारना" है। यही सोच इसे ठीक करना मुश्किल बनाती है। CLS कोई रहस्यमयी संख्या नहीं — यह इस बात का हिसाब है कि पेज पर चीज़ें पाठक के नीचे से कितनी बार खिसकीं।</p>

      <h2>हर shift की एक ठोस वजह होती है</h2>
      <p>और वे वजहें गिनी जा सकती हैं। व्यवहार में लगभग हमेशा इन्हीं में से एक होती है:</p>
      <ul>
        <li>बिना <code>width</code> और <code>height</code> वाली इमेज</li>
        <li>विज्ञापन या embed जिनके लिए जगह आरक्षित नहीं की गई</li>
        <li>बाद में लोड होने वाला फ़ॉन्ट जिसकी metrics अलग हैं</li>
        <li>कोई banner या notice जो DOM में ऊपर जुड़ जाता है</li>
        <li>हाइड्रेशन के बाद बदलने वाला content जिसका आकार अलग है</li>
      </ul>

      <h2>जगह पहले से आरक्षित कीजिए</h2>
      <p>यही पूरा समाधान है, और यह उबाऊ है। अगर किसी जगह बाद में कुछ आने वाला है, तो उसकी जगह अभी से रोक दीजिए — भले ही वह चीज़ कभी न आए।</p>
      <p>हमारे विज्ञापन slots की ऊँचाई पहले paint से तय है: consent मिलने से पहले भी, स्क्रिप्ट लोड होने से पहले भी, और तब भी जब कोई विज्ञापन कभी नहीं आएगा। खाली जगह दिखना उस गारंटी की क़ीमत है, और वह क़ीमत देने लायक़ है।</p>

      <h2>जो चीज़ें प्रवाह से बाहर हैं, वे shift नहीं करतीं</h2>
      <p>Cookie banner, audio player, toast — इन सबको <code>fixed</code> रखिए। जो element document flow में जगह नहीं घेरता, वह परिभाषा से ही कुछ नहीं खिसका सकता। यह अकेला नियम ad-funded साइटों की अधिकांश CLS समस्याएँ हल कर देता है।</p>

      <h2>इसे मापिए, मान कर मत चलिए</h2>
      <p>असली ब्राउज़र में <code>PerformanceObserver</code> से <code>layout-shift</code> entries देखिए, और सिर्फ़ पहले लोड पर नहीं — हर उस इंटरैक्शन पर जो content बदलता है। हमारी सबसे बड़ी CLS समस्या एक बटन का लेबल बदलने से आई थी, जो पास की चीज़ों की wrapping बदल देता था। मार्कअप पढ़कर वह कभी नहीं दिखती।</p>
    `,
  },
]

function textFrom(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Devanagari has no spaces-per-word difference worth modelling separately. */
const WORDS_PER_MINUTE = 225

async function main() {
  let created = 0
  let skipped = 0

  for (const t of TRANSLATIONS) {
    const [source] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.slug, t.sourceSlug), eq(posts.locale, 'en')))
      .limit(1)

    if (!source) {
      logger.warn({ slug: t.sourceSlug }, 'no English source post; skipping')
      skipped++
      continue
    }

    // Idempotent: re-running must not create a second Hindi row, which the
    // (slug, locale) unique index would reject anyway — better to say so.
    const [existing] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.slug, t.sourceSlug), eq(posts.locale, 'hi')))
      .limit(1)

    if (existing) {
      logger.info({ slug: t.sourceSlug }, 'Hindi translation already exists; skipping')
      skipped++
      continue
    }

    const contentText = textFrom(t.bodyHtml)
    const wordCount = contentText.split(/\s+/).filter(Boolean).length

    await db.insert(posts).values({
      // The SAME slug as the original, deliberately: the two URLs then differ
      // only by the /hi prefix, which is what makes the language switcher a
      // pure path transformation.
      slug: t.sourceSlug,
      locale: 'hi',
      translationOfId: source.id,

      title: t.title,
      subtitle: t.subtitle,
      excerpt: t.excerpt,
      contentHtml: t.bodyHtml.trim(),
      contentText,
      wordCount,
      readingMinutes: Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)),

      metaDescription: t.metaDescription,
      focusKeyword: t.focusKeyword,

      // Inherited: a translation is the same article, so it belongs to the
      // same category, the same author and the same cover.
      categoryId: source.categoryId,
      authorId: source.authorId,
      coverImageUrl: source.coverImageUrl,
      coverImageAlt: source.coverImageAlt,

      status: 'published',
      publishedAt: source.publishedAt ?? new Date(),
      allowComments: true,
      audioEnabled: true,
    })

    created++
    logger.info({ slug: t.sourceSlug, title: t.title }, 'Hindi translation created')
  }

  logger.info({ created, skipped }, 'Hindi seed complete')
  process.exit(0)
}

void main()
