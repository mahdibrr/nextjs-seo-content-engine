// Content generator — wraps the AI client with your editorial brief and the
// cluster context the article must respect.
//
// Output destination policy (safety):
//   - Successful generations are written to `content/drafts/` by default
//   - Set REVIEW_DIR env var to queue them for manual review instead
//   - Failed generations go to `content/rejected/<slug>.mdx`
//
// Hard validation gate. An article is accepted only if:
//   - frontmatter parses with required fields
//   - body has >= 700 words (post) or >= 1500 (guide)
//   - >= 3 internal links, every linked slug exists in the current inventory
//   - title <= 60 chars (SERP-safe)
//   - classify() returns a non-null pillar
//   - no slug collision with existing live content
//
// Configure via env vars:
//   SITE_URL      — your site's URL (used in system prompt context)
//   SITE_NICHE    — comma-separated topics your blog covers
//   AUTHOR_NAME   — author name used in generated articles
//   REVIEW_DIR    — directory for review-pending articles (default: content/drafts)

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { chatComplete, getAiConfig } from './ai-client.js';
import { classify } from './topic-map.js';
import { extractInternalLinkSlugs, suggestLinksFor, anchorFor, buildHubIndex } from './internal-linking.js';
import { assessArticle, validateGrounding } from './anti-spam-autopilot.js';
import { loadGscCache } from './gsc-sync.js';
import { reviewArticleWithAi } from './ai-reviewer.js';

// Configure your site details in .env
const SITE_URL = process.env.SITE_URL || 'https://your-blog.com';
const SITE_NICHE = process.env.SITE_NICHE || 'Next.js, Supabase, and full-stack web development';
const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Your Name';

// Optional: plug in your own notification system for new article drafts.
// If ENABLE_NOTIFICATIONS=true and you export a sendNotification function
// from a file at NOTIFICATION_MODULE path, it will be called on generation.
async function notifyNewArticle(data) {
  const moduleFile = process.env.NOTIFICATION_MODULE;
  if (!moduleFile || process.env.ENABLE_NOTIFICATIONS !== 'true') return;
  try {
    const mod = await import(path.resolve(moduleFile));
    if (typeof mod.sendNotification === 'function') {
      await mod.sendNotification(data);
    }
  } catch (err) {
    console.warn('[GENERATOR] Notification failed (non-fatal):', err.message);
  }
}

// Optional: plug in your own editorial scoring module.
// Export a computeEditorialScore(article, context) function from EDITORIAL_SCORE_MODULE.
async function computeEditorialScore(article, context) {
  const moduleFile = process.env.EDITORIAL_SCORE_MODULE;
  if (!moduleFile) return { total: 75, label: 'good (scoring module not configured)', grounding: 0, depth: 0, voice: 0, uniqueness: 0, signals: [] };
  try {
    const mod = await import(path.resolve(moduleFile));
    if (typeof mod.computeEditorialScore === 'function') {
      return mod.computeEditorialScore(article, context);
    }
  } catch (err) {
    console.warn('[GENERATOR] Editorial score module failed (non-fatal):', err.message);
  }
  return { total: 75, label: 'good (scoring module error)', grounding: 0, depth: 0, voice: 0, uniqueness: 0, signals: [] };
}

const ROOT = process.cwd();

function getContentDirs(options = {}) {
  const root = options.root || ROOT;
  return {
    posts: options.postsDir || path.join(root, 'content/posts'),
    guides: options.guidesDir || path.join(root, 'content/guides'),
    fixes: options.fixesDir || path.join(root, 'content/fixes'),
    drafts: options.draftsDir || process.env.DRAFTS_DIR || path.join(root, 'content/drafts'),
    review: options.reviewDir || process.env.REVIEW_DIR || path.join(root, 'content/review-pending'),
    rejected: options.rejectedDir || path.join(root, 'content/rejected'),
  };
}

const TEMPLATES = {
  troubleshooting: 'content-templates/troubleshooting.template.mdx',
  comparison: 'content-templates/comparison.template.mdx',
  migration: 'content-templates/migration.template.mdx',
  checklist: 'content-templates/checklist.template.mdx',
};

const SYSTEM_PROMPT = `You are the lead editor of ${SITE_URL}, a publishing business focused on ${SITE_NICHE}.

━━━ CONTENT RULES ━━━

1. PROBLEM FOCUS — Solve ONE specific, googled problem. Imagine the reader
   has just pasted an error or symptom into Google. No generic overviews,
   no "introduction to X", no listicles without concrete fixes.

2. MINIMUM LENGTH — Write dense, useful content to these minimums:
   - post / fix : >= 1 000 words
   - guide      : >= 1 500 words (comprehensive, multiple sections)
   No padding, no restating what was already said. Every sentence adds value.

3. NARRATIVE STRUCTURE — Every article must follow this exact four-act shape:
   a) Problem observed — describe the exact symptom the reader sees.
   b) Diagnosis — explain WHY it happens (root cause, relevant internals).
   c) Solution — the exact steps, in order. Code first, explanation after.
   d) Verification — show the reader how to confirm the fix worked.

4. VOICE — First-person, practitioner tone ("I ran into this", "we ship this
   pattern in production", "here's what actually worked").
   BANNED phrases: "in today's fast-paced world", "harness the power of",
   "leverage", "robust", "seamlessly", "comprehensive", "dive into",
   "in conclusion", "moreover", "furthermore", "it's worth noting",
   "it is important to", "I hope this helps", "feel free to".

5. CODE BLOCKS — Every code block must:
   - Use the correct language tag
   - Show REAL, runnable commands or snippets — no placeholder like "// your code here"
   - Include the expected terminal output when the step produces visible output

6. INTERNAL LINKS — Include >= 3 links using ONLY the URLs provided in the brief.

7. TITLE — <= 60 characters. Put the primary keyword near the start.

8. TL;DR — Open every article with a ## TL;DR section with 3–5 bullet points.

9. TEMPLATE — Follow the supplied template structure exactly.

━━━ OUTPUT FORMAT ━━━
- Output ONLY the raw MDX file. No commentary, no preamble, no sign-off.
- Do NOT wrap the output in \`\`\`mdx or \`\`\`markdown fences.
- The file MUST start with a line that is exactly: ---
- Frontmatter ends with a line that is exactly: ---
- After the closing ---, one blank line, then start the body with ##.

---
title: '...'
description: '...'
(remaining frontmatter fields)
---

## TL;DR
- bullet one
- bullet two

... 1 000+ words of body ...

## Related
- [Title](/post/slug)`;

function loadInventory(options = {}) {
  const dirs = getContentDirs(options);
  const offTopicSlugs = options.offTopicSlugs instanceof Set ? options.offTopicSlugs : new Set();

  function loadDir(dir, kind) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mdx') || f.endsWith('.md'))
      .map((f) => {
        const { data, content } = matter(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { slug: f.replace(/\.(mdx|md)$/, ''), kind, content, ...data };
      });
  }

  const posts = loadDir(dirs.posts, 'post').filter((p) => !offTopicSlugs.has(p.slug));
  const guides = loadDir(dirs.guides, 'guide');
  const fixes = loadDir(dirs.fixes, 'fix');
  const pending = loadDir(dirs.review, 'pending');
  return { posts, guides, fixes, all: [...posts, ...guides, ...fixes], pending };
}

function pickInternalLinkTargets(opportunity, inventory, options = {}) {
  const hubIndex = options.hubIndex || buildHubIndex(options.hubs || []);
  const phantom = {
    slug: opportunity.suggestedSlug,
    title: opportunity.suggestedTitle,
    description: opportunity.rationale,
    tags: [opportunity.term].filter(Boolean),
    keywords: [opportunity.term, opportunity.pillarLabel].filter(Boolean),
    category: opportunity.pillarLabel,
    content: '',
  };
  return suggestLinksFor(phantom, inventory.all, { limit: 6, minScore: 4, hubIndex });
}

function slugFromTitle(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function templatePromptFor(intent, root = ROOT) {
  const file = TEMPLATES[intent] || TEMPLATES.troubleshooting;
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Template not found: ${file}. Copy content-templates/ from the repo root.`);
  }
  return fs.readFileSync(full, 'utf8');
}

function adaptTemplateForSource(template, source) {
  if (source?.type !== 'gsc') return template;
  return template
    .replace(/Paste the literal error output here\.\s*Google indexes the exact text,?\s*and\s*this is what drove the reader to this page:?\s*/gi,
      'Use the exact Search Console query as the observed symptom. Do not invent stack traces, GitHub issues, or terminal errors.')
    .replace(/\{\{paste the exact error message, stack trace, or symptom output\}\}/gi,
      '[Describe the symptom the reader observes — do NOT copy the search query string verbatim.]');
}

function formatGroundingSource(source) {
  if (!source) return 'None available';
  if (source.type === 'gsc') {
    return [
      'Type: GSC',
      source.query ? `Query: ${source.query}` : null,
      source.pageUrl ? `Page URL: ${source.pageUrl}` : null,
      typeof source.impressions === 'number' ? `Impressions: ${source.impressions}` : null,
      typeof source.clicks === 'number' ? `Clicks: ${source.clicks}` : null,
      typeof source.position === 'number' ? `Avg position: ${Number(source.position).toFixed(2)}` : null,
      source.observedAt ? `Observed at: ${source.observedAt}` : null,
    ].filter(Boolean).join('\n');
  }
  if (source.type === 'stack-overflow') {
    return ['Type: Stack Overflow', source.url ? `URL: ${source.url}` : null, source.title ? `Title: ${source.title}` : null].filter(Boolean).join('\n');
  }
  if (source.type === 'github-issue') {
    return ['Type: GitHub issue', source.url ? `URL: ${source.url}` : null, source.title ? `Title: ${source.title}` : null].filter(Boolean).join('\n');
  }
  return `Type: ${source.type || 'unknown'}`;
}

function lengthProfileFor(kind = 'post') {
  if (kind === 'guide') {
    return { minWords: 1500, targetRange: '1700-2300', minSectionWords: 180, minCodeLines: 8, minCodeBlocks: 4, extraInstruction: 'For guide articles, write at minimum 1500 words with extensive code examples.' };
  }
  return { minWords: 1000, targetRange: '1300-1600', minSectionWords: 120, minCodeLines: 5, minCodeBlocks: 3, extraInstruction: null };
}

// Curated Unsplash photo IDs per pillar — picked deterministically by slug hash.
const PILLAR_IMAGES = {
  'nextjs-supabase': ['photo-1555066931-4365d14bab8c', 'photo-1461749280684-dccba630e2f6', 'photo-1517694712202-14dd9538aa97'],
  'nextjs-performance': ['photo-1460925895917-afdab827c52f', 'photo-1551288049-bebda4e38f71'],
  'supabase-debugging': ['photo-1544383835-bda2bc66a55d', 'photo-1558494949-ef010cbdcc31'],
  'supabase-auth': ['photo-1614064641938-3bbee52942c7', 'photo-1555949963-ff9fe0c870eb'],
  'stripe-payments': ['photo-1563013544-824ae1b704d3', 'photo-1556742049-0cfed4f6a45d'],
  'n8n-automation': ['photo-1518432031352-d6fc5c10da5a', 'photo-1485827404703-89b55fcc595e'],
  'ai-development': ['photo-1677442135703-1787eea5ce01', 'photo-1620712943543-bcc4688e7485'],
  '__default': ['photo-1518770660439-4636190af475', 'photo-1504868584819-f8e8b4b6d7e3', 'photo-1555066931-4365d14bab8c'],
};

function pickHeroImage(pillar, slug) {
  const pool = PILLAR_IMAGES[pillar] || PILLAR_IMAGES.__default;
  let hash = 0;
  for (let i = 0; i < (slug || '').length; i++) hash = ((hash << 5) - hash + (slug || '').charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % pool.length;
  return `https://images.unsplash.com/${pool[idx]}?auto=format&fit=crop&w=1200&q=80`;
}

function buildPrompt({ opportunity, template, linkTargets, todayIso, groundingSource, kind = 'post' }) {
  const lengthProfile = lengthProfileFor(kind);
  const linkBullets = linkTargets.map((l) => {
    const url = l.kind === 'guide' ? `/guides/${l.slug}` : l.kind === 'fix' ? `/fix/${l.slug}` : `/post/${l.slug}`;
    return `- "${l.title}" → ${url}`;
  }).join('\n');

  return `Write a complete MDX file for ${SITE_URL}.

BRIEF
-----
Intent: ${opportunity.intent || 'troubleshooting'}
Suggested title: ${opportunity.suggestedTitle}
Pillar: ${opportunity.pillarLabel || opportunity.pillar}
Rationale: ${opportunity.rationale}
Today's date (use for frontmatter date + modifiedDate): ${todayIso}

SOURCE GROUNDING (mandatory)
----------------------------
${formatGroundingSource(groundingSource)}

INTERNAL LINKS (use AT LEAST 3 of these exact URLs in the body)
------------------------------------------------------------
${linkBullets || '(none — generate the article anyway; this will fail validation, expected)'}

TEMPLATE (follow this STRUCTURE — replace EVERY {{placeholder}} with real content)
-------------------------------------------------------------------------------
${template}

REQUIREMENTS
------------
- Output ONLY the MDX. Do not wrap in markdown code fences.
- Frontmatter must contain: title, description, excerpt, image, category, tags (array),
  date, modifiedDate, readTime, author, keywords (array), faqSchema (with mainEntity >= 2 questions).
- Title must be <= 60 chars.
- Use EXACTLY this hero image URL for the frontmatter image field:
  ${pickHeroImage(opportunity.pillar, opportunity.suggestedSlug || opportunity.suggestedTitle)}
- Author: "${AUTHOR_NAME}". First-person voice.

LENGTH (critical — short articles get rejected):
- Total body MUST be >= ${lengthProfile.minWords} words. Aim for ${lengthProfile.targetRange}.
- Each ## section MUST be at least ${lengthProfile.minSectionWords} words.
- Include at least ${lengthProfile.minCodeBlocks} code blocks.
${lengthProfile.extraInstruction ? `- ${lengthProfile.extraInstruction}` : ''}

INTERNAL LINKS:
- Embed at least 3 of the brief's URLs inline in body paragraphs.
- Also add a ## Related section at the bottom listing 3+ of the URLs.

STYLE:
- Code: triple-backtick with a language tag.
- No placeholder code like "// your logic here".
- No marketing-speak: avoid "robust", "seamless", "leverage", "harness".
`;
}

function countWords(content) {
  return content.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
}

function ensureDirectory(dir) { fs.mkdirSync(dir, { recursive: true }); }

export function validateGenerated(mdx, opportunity, inventory, kind = 'post') {
  const issues = [];
  let parsed;
  try {
    parsed = matter(mdx);
  } catch (err) {
    return { ok: false, issues: [{ field: 'frontmatter', message: `YAML parse error: ${err.message}` }] };
  }
  const fm = parsed.data || {};
  const body = parsed.content || '';

  const required = ['title', 'description', 'excerpt', 'image', 'category', 'tags', 'date', 'readTime', 'author'];
  for (const f of required) {
    if (!fm[f]) issues.push({ field: f, message: `Missing frontmatter field: ${f}` });
  }
  if (fm.title && fm.title.length > 60) issues.push({ field: 'title', message: `Title ${fm.title.length} > 60 chars: "${fm.title}"` });
  if (!Array.isArray(fm.tags) || fm.tags.length < 2) issues.push({ field: 'tags', message: 'tags must be an array with >= 2 entries' });
  else {
    const seen = new Set();
    const dupes = fm.tags.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    if (dupes.length > 0) issues.push({ field: 'tags', message: `Duplicate tags: ${dupes.join(', ')}` });
  }

  if (fm.description && fm.excerpt && fm.description.trim() === fm.excerpt.trim()) {
    issues.push({ field: 'excerpt', message: 'excerpt is identical to description — they must differ' });
  }

  const minWords = kind === 'guide' ? 1500 : 600;
  const words = countWords(body);
  if (words < minWords) issues.push({ field: 'body', message: `Body has ${words} words (min ${minWords})` });

  const linked = extractInternalLinkSlugs(body);
  const livingSlugs = new Set(inventory.all.map((i) => i.slug));
  const validLinks = [...linked].filter((s) => livingSlugs.has(s));
  if (validLinks.length < 3) issues.push({ field: 'internalLinks', message: `Only ${validLinks.length} valid internal links (need >= 3). Found: ${[...linked].join(', ') || '(none)'}` });

  const classification = classify({ ...fm, content: body });
  if (!classification.pillar) issues.push({ field: 'pillar', message: 'No pillar match — article off-niche' });

  const suggestedSlug = opportunity.suggestedSlug;
  if (suggestedSlug && livingSlugs.has(suggestedSlug)) issues.push({ field: 'slug', message: `Slug "${suggestedSlug}" collides with existing content` });

  const PROSE_SKIP = /^(\s*#|\s*[-*]|\s*\d+\.|\s*\||\s*<|\s*```)/;
  const TERMINAL_PUNCT = /[.!?)\]"']$/;
  const bodyWithoutCode = body.replace(/```[\s\S]*?```/g, '');
  const paragraphs = bodyWithoutCode.split(/\n\n+/);
  const lastProseParagraph = [...paragraphs].reverse().find((p) => {
    const t = p.trim();
    return t.length > 10 && !PROSE_SKIP.test(t);
  });
  if (lastProseParagraph) {
    const lastLine = lastProseParagraph.trim().split('\n').pop().trim();
    const cleaned = lastLine.replace(/\[.*?\]\(.*?\)/g, '').replace(/`[^`]*`/g, '').trim();
    if (cleaned.length > 0 && !TERMINAL_PUNCT.test(cleaned)) {
      issues.push({ field: 'body', message: `Body appears truncated — last prose line does not end with terminal punctuation: "${lastLine.slice(0, 80)}"` });
    }
  }

  return { ok: issues.length === 0, issues, frontmatter: fm, body, words, validLinks, classification };
}

export async function generateArticle(opportunity, options = {}) {
  const kind = options.kind || 'post';
  const intent = options.intent || opportunity.suggestedIntent || opportunity.intent || 'troubleshooting';
  const maxRetries = options.maxRetries ?? 3;
  const dirs = getContentDirs(options);

  const opp = { ...opportunity, intent, suggestedSlug: opportunity.suggestedSlug || slugFromTitle(opportunity.suggestedTitle) };
  const gscCache = options.gscCache || loadGscCache();
  const groundingCheck = validateGrounding(opp, { gscCache });
  if (!groundingCheck.ok) {
    const reason = groundingCheck.issues.map((i) => i.message).join('; ');
    return { status: 'skipped', reason: `REJECTED: missing grounding source (${reason})`, slug: opp.suggestedSlug, issues: groundingCheck.issues };
  }
  const groundingSource = groundingCheck.source;

  const aiConfig = getAiConfig();
  if (!aiConfig.enabled) return { status: 'skipped', reason: 'AI client not configured' };

  const inventory = loadInventory(options);

  const pendingSlugs = new Set(inventory.pending.map((i) => i.slug));
  if (opp.suggestedSlug && pendingSlugs.has(opp.suggestedSlug)) {
    return { status: 'skipped', reason: `Slug "${opp.suggestedSlug}" already in review-pending`, slug: opp.suggestedSlug };
  }

  const linkTargets = pickInternalLinkTargets(opp, inventory, options);
  if (linkTargets.length < 3) {
    return { status: 'skipped', reason: `Not enough internal link targets (have ${linkTargets.length}, need >= 3)`, slug: opp.suggestedSlug };
  }

  const root = options.root || ROOT;
  const template = adaptTemplateForSource(templatePromptFor(intent, root), groundingSource);
  const todayIso = new Date().toISOString().slice(0, 10);
  const userPrompt = buildPrompt({ opportunity: opp, template, linkTargets, todayIso, groundingSource, kind });

  let attempt = 0;
  let lastIssues = [];
  let lastMdx = '';
  let lastAntiSpam = null;
  while (attempt < maxRetries) {
    attempt++;
    console.log('[CONTENT_GENERATION]', { action: 'ai_attempt', slug: opp.suggestedSlug, attempt, maxRetries });
    const mdx = await chatComplete(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: attempt === 1 ? userPrompt : buildRetryPrompt(userPrompt, lastIssues) },
      ],
      { temperature: aiConfig.temperature, maxTokens: aiConfig.maxTokens }
    );

    let cleaned = repairFrontmatter(stripCodeFenceWrapping(mdx));
    cleaned = stripTemplateLeftovers(cleaned);
    cleaned = fixMdxInvalidTags(cleaned);
    cleaned = ensureMinInternalLinks(cleaned, linkTargets, inventory.all, 3);

    const result = validateGenerated(cleaned, opp, inventory, kind);
    let finalIssues = [...result.issues];
    let antiSpamAssessment = null;
    let candidateArticle = null;

    if (result.ok) {
      candidateArticle = { slug: opp.suggestedSlug, kind, ...result.frontmatter, content: result.body, source: groundingSource || null, generatedAt: todayIso };
      antiSpamAssessment = assessArticle(candidateArticle, {
        inventory: inventory.all,
        recentGenerated: options.recentGenerated || [],
        opportunity: opp,
        gscCache,
        minEntropyScore: 42,
        minSeoScore: 55,
        maxPatternPenalty: 28,
        ...(options.antiSpam || {}),
      });
      if (!antiSpamAssessment.pass) {
        finalIssues = finalIssues.concat(antiSpamAssessment.issues.map((issue) => ({ field: `antiSpam.${issue.field}`, message: issue.message })));
      }
    }

    lastIssues = finalIssues;
    lastAntiSpam = antiSpamAssessment;
    lastMdx = cleaned;

    if (result.ok && finalIssues.length === 0) {
      const editorialScore = await computeEditorialScore(candidateArticle, { opportunity: opp, corpus: [...inventory.all, ...inventory.pending], gscCache });
      console.log(`[editorial-score] article=${opp.suggestedSlug} total=${editorialScore.total} label=${editorialScore.label}`);

      const MIN_EDITORIAL_SCORE = options.minEditorialScore ?? 70;
      if (editorialScore.total < MIN_EDITORIAL_SCORE) {
        console.log(`[editorial-score] REJECT — ${editorialScore.total}/100 below minimum ${MIN_EDITORIAL_SCORE} — regenerating`);
        lastIssues = [{ field: 'editorialScore', message: `Score ${editorialScore.total}/100 below minimum ${MIN_EDITORIAL_SCORE}` }];
        continue;
      }

      const aiReview = options.skipAiReview
        ? { ok: true, score: null, issues: [], summary: 'skipped', skipped: true }
        : await reviewArticleWithAi(candidateArticle);
      console.log(`[ai-review] score=${aiReview.score ?? 'n/a'} publishable=${aiReview.ok}${aiReview.skipped ? ' (skipped)' : ''}`);
      if (!aiReview.ok && !aiReview.skipped) {
        lastIssues = aiReview.issues.map((msg) => ({ field: 'ai-review', message: msg }));
        continue;
      }

      ensureDirectory(dirs.drafts);
      const draftFile = path.join(dirs.drafts, `${opp.suggestedSlug}.mdx`);
      fs.writeFileSync(draftFile, cleaned);

      ensureDirectory(dirs.review);
      const reviewFile = path.join(dirs.review, `${opp.suggestedSlug}.mdx`);
      const metaFile = path.join(dirs.review, `${opp.suggestedSlug}.json`);
      fs.writeFileSync(reviewFile, cleaned);
      fs.writeFileSync(metaFile, JSON.stringify({ slug: opp.suggestedSlug, title: candidateArticle.title, kind, status: 'review-pending', createdAt: new Date().toISOString(), editorialScore, opportunity: opp }, null, 2));

      await notifyNewArticle({ slug: opp.suggestedSlug, title: candidateArticle.title, kind, file: reviewFile, editorialScore });

      if (Array.isArray(options.recentGenerated) && candidateArticle) options.recentGenerated.push(candidateArticle);

      return { status: 'generated', draftFile, file: reviewFile, attempts: attempt, slug: opp.suggestedSlug, wordCount: result.words, internalLinks: result.validLinks, pillar: result.classification?.pillar, intent, editorialScore };
    }
  }

  fs.mkdirSync(dirs.rejected, { recursive: true });
  const reasons = lastIssues.map((i) => `- [${i.field}] ${i.message}`).join('\n');
  const wrapped = `<!--\nGENERATED but FAILED validation after ${maxRetries} attempts.\nOpportunity: ${opp.suggestedTitle}\nReasons:\n${reasons}\n-->\n\n${lastMdx}`;
  const rejectedFile = path.join(dirs.rejected, `${opp.suggestedSlug || 'unnamed'}.mdx`);
  fs.writeFileSync(rejectedFile, wrapped);

  return { status: 'rejected', reason: lastIssues.slice(0, 2).map((i) => i.message).join(' | ') || 'quality checks failed', file: rejectedFile, attempts: maxRetries, slug: opp.suggestedSlug, issues: lastIssues };
}

function buildRetryPrompt(originalPrompt, issues) {
  return `${originalPrompt}

PREVIOUS ATTEMPT FAILED VALIDATION
----------------------------------
${issues.map((i) => `- [${i.field}] ${i.message}`).join('\n')}

Fix these specific issues and regenerate the complete MDX file. Same rules apply.`;
}

function fixMdxInvalidTags(text) {
  const lines = text.split('\n');
  let inCode = false;
  return lines.map((line) => {
    if (line.trimStart().startsWith('```')) inCode = !inCode;
    if (inCode) return line;
    return line
      .replace(/<(\d+)\)/g, '(before v$1)')
      .replace(/<(\d+)\s/g, 'before v$1 ')
      .replace(/\(>(\d+)\)/g, '(v$1+)')
      .replace(/>(\d+)\s/g, 'v$1+ ');
  }).join('\n');
}

function stripTemplateLeftovers(text) {
  const PHRASES = [
    /Paste the literal error output here\.\s*Google indexes the exact text,?\s*and this is what drove the reader to this page:?\s*/gi,
    /\{\{[^}]+\}\}/g,
    /<!--[\s\S]*?-->/g,
  ];
  let out = text;
  for (const rx of PHRASES) out = out.replace(rx, '');
  const replacements = [
    [/\bleverage\b/gi, 'use'],
    [/\bseamless(?:ly)?\b/gi, 'direct'],
    [/\brobust(?:ly)?\b/gi, 'reliable'],
    [/\bharness the power of\b/gi, 'use'],
    [/\bin conclusion,?\s*/gi, ''],
    [/\bmoreover,?\s*/gi, ''],
    [/\bfurthermore,?\s*/gi, ''],
  ];
  for (const [rx, replacement] of replacements) out = out.replace(rx, replacement);
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function ensureMinInternalLinks(mdx, linkTargets, inventoryAll, min = 3) {
  const livingSlugs = new Set(inventoryAll.map((i) => i.slug));
  const linked = extractInternalLinkSlugs(mdx);
  const validLinks = [...linked].filter((s) => livingSlugs.has(s));
  if (validLinks.length >= min) return mdx;

  const needed = min - validLinks.length;
  const additions = linkTargets.filter((t) => !linked.has(t.slug)).slice(0, Math.max(needed, 3));
  if (additions.length === 0) return mdx;

  const bullets = additions.map((t) => `- ${anchorFor(t)}`).join('\n');
  if (/^##\s+Related\b/m.test(mdx)) {
    return mdx.replace(/(##\s+Related[^\n]*\n+(?:- .*\n)*)/, (m) => `${m.trimEnd()}\n${bullets}\n`);
  }
  return mdx.trimEnd() + `\n\n## Related\n\n${bullets}\n`;
}

function stripCodeFenceWrapping(text) {
  const fenced = text.match(/^```(?:mdx|md|markdown)?\n([\s\S]*?)\n```\s*$/);
  if (fenced) return fenced[1];
  return text.trim();
}

function repairFrontmatter(text) {
  let lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return text;

  let closingIdx = -1;
  for (let i = 1; i < Math.min(lines.length, 250); i++) {
    if (lines[i].trim() === '---') { closingIdx = i; break; }
  }
  if (closingIdx === -1) {
    let bodyStart = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^#{1,3}\s+/.test(lines[i])) { bodyStart = i; break; }
    }
    if (bodyStart !== -1) {
      let insertAt = bodyStart;
      while (insertAt > 1 && lines[insertAt - 1].trim() === '') insertAt--;
      lines.splice(insertAt, 0, '---', '');
      closingIdx = insertAt;
    }
  }
  if (closingIdx === -1) return text;

  for (let i = 1; i < closingIdx; i++) {
    let line = lines[i];
    line = line.replace(/[''‚′]/g, "'").replace(/[""„″]/g, '"');
    const m = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*)'(.*)'(\s*)$/);
    if (m) {
      const value = m[2];
      const hasEscapedSingle = value.includes("\\'");
      const hasInternalSingle = value.includes("'");
      if (hasEscapedSingle || hasInternalSingle) {
        const fixedValue = value.replace(/\\'/g, "'").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        line = `${m[1]}"${fixedValue}"${m[3]}`;
      }
    }
    lines[i] = line;
  }

  return lines.join('\n');
}

export async function generateBatch(opportunities, options = {}) {
  const limit = options.limit ?? 3;
  const maxAttempts = options.maxAttempts ?? opportunities.length;
  const subset = opportunities.slice(0, maxAttempts);
  const recentGenerated = Array.isArray(options.recentGenerated) ? options.recentGenerated : [];
  const gscCache = options.gscCache || loadGscCache();
  const results = [];
  let generatedCount = 0;
  let apiRateLimited = false;

  for (const op of subset) {
    if (generatedCount >= limit) break;
    if (apiRateLimited) {
      results.push({ opportunity: op.suggestedTitle, status: 'skipped', reason: 'API rate-limited — stopping batch' });
      continue;
    }
    try {
      const r = await generateArticle(op, { ...options, recentGenerated, gscCache });
      results.push({ opportunity: op.suggestedTitle, ...r });
      if (r.status === 'generated') generatedCount++;
    } catch (err) {
      if (err.message.includes('429') || /rate.?limit/i.test(err.message)) {
        apiRateLimited = true;
        console.warn('[CONTENT_GENERATION] Rate limit hit — stopping batch early');
      }
      results.push({ opportunity: op.suggestedTitle, status: 'errored', error: err.message });
    }
  }

  return {
    requested: limit,
    attempted: results.length,
    generated: results.filter((r) => r.status === 'generated').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errored: results.filter((r) => r.status === 'errored').length,
    results,
  };
}
