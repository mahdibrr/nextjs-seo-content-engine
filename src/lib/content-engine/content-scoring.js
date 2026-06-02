// Content scoring — per-item 0..100 score combining the SEO signals we
// can measure from the file alone.

import { classify, PILLARS, asArray } from './topic-map.js';
import { extractInternalLinkSlugs } from './internal-linking.js';

const MAX_TITLE_SERP = 60;
const MIN_TITLE = 30;
const MIN_DESCRIPTION = 110;
const MAX_DESCRIPTION = 160;
const MIN_WORDS_POST = 800;
const MIN_WORDS_GUIDE = 2000;

// Set SITE_DOMAIN in your .env to exclude your own site from outbound link counts.
const SITE_DOMAIN = process.env.SITE_DOMAIN || '';

function wordCount(content) {
  if (!content) return 0;
  return content.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
}

function extractHeadings(content) {
  if (!content) return [];
  const out = [];
  const rx = /^(#{1,6})\s+(.+)$/gm;
  let m;
  while ((m = rx.exec(content)) !== null) out.push({ level: m[1].length, text: m[2].trim() });
  return out;
}

function extractOutboundLinks(content) {
  if (!content) return [];
  const out = [];
  const rx = /\[[^\]]+\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = rx.exec(content)) !== null) {
    const url = m[1];
    if (SITE_DOMAIN && url.includes(SITE_DOMAIN)) continue;
    out.push(url);
  }
  return out;
}

function hasSchema(item) {
  const flags = {
    article: true,
    faq: !!(item.faqSchema && item.faqSchema.mainEntity && item.faqSchema.mainEntity.length > 0),
    howTo: false,
  };
  if (item.content) {
    const numbered = (item.content.match(/^\s*\d+\.\s+/gm) || []).length;
    if (numbered >= 3) flags.howTo = true;
  }
  return flags;
}

export function scoreItem(item, kind = 'post') {
  const breakdown = {};
  const issues = [];

  let titleScore = 0;
  const title = (item.title || '').trim();
  if (!title) {
    issues.push({ field: 'title', severity: 'critical', message: 'Missing title' });
  } else {
    if (title.length >= MIN_TITLE) titleScore += 4;
    else issues.push({ field: 'title', severity: 'warn', message: `Title shorter than ${MIN_TITLE} chars (${title.length})` });

    if (title.length <= MAX_TITLE_SERP) titleScore += 4;
    else issues.push({ field: 'title', severity: 'warn', message: `Title risks SERP truncation (${title.length} > ${MAX_TITLE_SERP})` });

    if (/\b(fix|build|migrate|debug|guide|how|why|vs|complete|step)\b/i.test(title)) titleScore += 4;
  }
  breakdown.title = titleScore;

  let descScore = 0;
  const description = (item.description || item.excerpt || '').trim();
  if (!description) {
    issues.push({ field: 'description', severity: 'critical', message: 'Missing description/excerpt' });
  } else {
    if (description.length >= MIN_DESCRIPTION) descScore += 6;
    else issues.push({ field: 'description', severity: 'warn', message: `Description shorter than ${MIN_DESCRIPTION} chars (${description.length})` });

    if (description.length <= MAX_DESCRIPTION) descScore += 6;
    else issues.push({ field: 'description', severity: 'warn', message: `Description longer than ${MAX_DESCRIPTION} chars (${description.length})` });
  }
  breakdown.description = descScore;

  const words = wordCount(item.content);
  const minWords = kind === 'guide' ? MIN_WORDS_GUIDE : MIN_WORDS_POST;
  let lengthScore = 0;
  if (words >= minWords) lengthScore = 14;
  else if (words >= minWords * 0.6) lengthScore = 9;
  else if (words >= minWords * 0.3) lengthScore = 4;
  else issues.push({ field: 'content', severity: 'critical', message: `Thin content: ${words} words (target ≥${minWords})` });
  breakdown.length = lengthScore;

  const headings = extractHeadings(item.content);
  let headingScore = 0;
  const h2Count = headings.filter((h) => h.level === 2).length;
  if (h2Count >= 3) headingScore += 4;
  else if (h2Count >= 1) headingScore += 2;
  else issues.push({ field: 'headings', severity: 'warn', message: 'No H2 headings — TOC will be empty' });

  if (headings.some((h) => h.level === 3)) headingScore += 2;
  if (headings.length >= 5) headingScore += 4;
  breakdown.headings = headingScore;

  const internalLinks = extractInternalLinkSlugs(item.content);
  let internalScore = 0;
  if (internalLinks.size >= 5) internalScore = 14;
  else if (internalLinks.size >= 3) internalScore = 9;
  else if (internalLinks.size >= 1) internalScore = 4;
  else issues.push({ field: 'internalLinks', severity: 'warn', message: 'No internal links — orphan risk' });
  breakdown.internalLinks = internalScore;

  const outbound = extractOutboundLinks(item.content);
  let outboundScore = 0;
  if (outbound.length >= 3) outboundScore = 6;
  else if (outbound.length >= 1) outboundScore = 3;
  else issues.push({ field: 'outboundLinks', severity: 'info', message: 'No outbound authority links' });
  breakdown.outboundLinks = outboundScore;

  const schema = hasSchema(item);
  let schemaScore = 0;
  if (schema.article) schemaScore += 4;
  if (schema.faq) schemaScore += 4;
  if (schema.howTo) schemaScore += 2;
  if (!schema.faq && kind !== 'fix') {
    issues.push({ field: 'schema', severity: 'info', message: 'No FAQ schema — missing rich-result opportunity' });
  }
  breakdown.schema = schemaScore;

  let metaScore = 0;
  if (item.image) metaScore += 2; else issues.push({ field: 'image', severity: 'warn', message: 'Missing cover image' });
  const tags = asArray(item.tags);
  const keywords = asArray(item.keywords);
  if (tags.length >= 3) metaScore += 2; else issues.push({ field: 'tags', severity: 'info', message: 'Fewer than 3 tags' });
  if (keywords.length >= 3) metaScore += 2; else issues.push({ field: 'keywords', severity: 'info', message: 'Fewer than 3 keywords' });
  if (item.modifiedDate) metaScore += 2; else issues.push({ field: 'modifiedDate', severity: 'info', message: 'No modifiedDate — freshness signal weak' });
  if (item.readTime) metaScore += 2; else issues.push({ field: 'readTime', severity: 'info', message: 'No readTime in frontmatter' });
  breakdown.metadata = metaScore;

  const { pillar, intent, score: pillarScore } = classify(item);
  let topicalScore = 0;
  if (pillar) {
    topicalScore += 8;
    const weight = (PILLARS[pillar] && PILLARS[pillar].weight) || 0.5;
    topicalScore += Math.round(weight * 4);
  } else {
    issues.push({ field: 'topicalAlignment', severity: 'warn', message: 'No pillar match — off-niche risk' });
  }
  breakdown.topical = topicalScore;

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return {
    slug: item.slug,
    title: item.title,
    kind,
    pillar,
    intent,
    pillarMatchScore: pillarScore,
    words,
    headings: { total: headings.length, h2: h2Count },
    internalLinks: internalLinks.size,
    outboundLinks: outbound.length,
    schema,
    score: total,
    breakdown,
    issues,
  };
}

export function scoreAll(items, kind) {
  return items.map((i) => scoreItem(i, kind)).sort((a, b) => a.score - b.score);
}
