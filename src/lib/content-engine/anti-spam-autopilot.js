// Anti-spam autopilot for AI-generated content.
//
// Goals:
// - Block low-entropy, repetitive, generic content.
// - Enforce source grounding from real signals (GSC / Stack Overflow / GitHub issues / error logs).
// - Enforce structural diversity across generated output.

import { classify } from './topic-map.js';
import { scoreItem } from './content-scoring.js';
import { loadGscCache, keywordGaps, lowCtrPages } from './gsc-sync.js';

const SOURCE_TYPES = new Set(['gsc', 'stack-overflow', 'github-issue', 'error-log', 'topic-map']);

const TOKEN_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'from',
  'with', 'without', 'to', 'of', 'in', 'on', 'at', 'by', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'as', 'we',
  'you', 'your', 'our', 'i', 'my', 'they', 'them', 'their', 'can', 'could',
  'should', 'would', 'will', 'just', 'about', 'into', 'over', 'under', 'also',
  'than', 'after', 'before', 'during', 'using', 'use',
]);

const AI_CLICHE_PATTERNS = [
  /\bin today's fast[- ]paced (?:world|landscape)\b/gi,
  /\bharness the power of\b/gi,
  /\bleverage\b/gi,
  /\bseamless(?:ly)?\b/gi,
  /\brobust(?:ly)?\b/gi,
  /\bmoreover\b/gi,
  /\bfurthermore\b/gi,
  /\bin conclusion\b/gi,
  /\beverything you need to know\b/gi,
  /\bgame[- ]changer\b/gi,
  /\bultimate guide\b/gi,
];

const GENERIC_SEO_TITLE_PATTERNS = [
  /^\s*(ultimate|complete|definitive)\s+guide\b/i,
  /^\s*top\s+\d+\b/i,
  /\beverything you need to know\b/i,
];

const STRICT_GENERIC_TITLE_PATTERNS = [
  /^\s*(ultimate|complete|definitive)\s+guide\b/i,
  /\bultimate guide\b/i,
  /^\s*fix\s+.+\s+in production\s*$/i,
];

const INCIDENT_CONTEXT_PATTERNS = [
  /\berror\b/i, /\bexception\b/i, /\btypeerror\b/i, /\breferenceerror\b/i,
  /\b500\b/, /\b502\b/, /\b503\b/, /\bstack trace\b/i, /\btraceback\b/i,
  /\bnot working\b/i, /\bfailing\b/i, /\bdisable(?:d|s|ing)?\b/i, /\bstuck\b/i,
  /\bredirect(?:s|ed|ing)?\b/i, /\bproduction build\b/i,
  /\bbuild\s+(?:fail|fails|failed|error|stuck|hangs?|disable)\b/i,
  /\bincident\b/i, /\bcrash(?:ed|ing)?\b/i, /\btimeout\b/i,
  /\bimplement(?:ing|ation)?\b/i, /\bchecklist\b/i, /\bmigrat(?:e|ing|ion)\b/i,
  /\bset\s*up\b/i, /\bconfigur(?:e|ing|ation)\b/i, /\bintegrat(?:e|ing|ion)\b/i,
];

const PHRASE_BANNERS = [
  /\{\{[^}]+\}\}/g,
  /\[INTERNAL LINK:[^\]]+\]/gi,
  /paste the literal error output here/gi,
  /your logic here/gi,
  /TODO:?/gi,
];

const DAY_MS = 86_400_000;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clamp01(value) { return clamp(value, 0, 1); }

function toWords(text) {
  return String(text || '').toLowerCase()
    .replace(/[`*_#>\[\]{}()!?,.:;"'\\/|-]+/g, ' ')
    .split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

function meaningfulWords(text) {
  return toWords(text).filter((w) => w.length > 2 && !TOKEN_STOPWORDS.has(w));
}

function countCodeBlocks(content) {
  return (String(content || '').match(/```[\s\S]*?```/g) || []).length;
}

function countChecklistItems(content) {
  return (String(content || '').match(/^\s*-\s*\[[xX ]\]\s+/gm) || []).length;
}

function splitSentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function splitParagraphs(text) {
  return String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function makeNgrams(tokens, n) {
  if (tokens.length < n) return [];
  const grams = [];
  for (let i = 0; i <= tokens.length - n; i++) grams.push(tokens.slice(i, i + n).join(' '));
  return grams;
}

function frequencyMap(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) || 0) + 1);
  return map;
}

function topShare(values) {
  if (!values.length) return 0;
  const freq = frequencyMap(values);
  let maxCount = 0;
  for (const count of freq.values()) if (count > maxCount) maxCount = count;
  return maxCount / values.length;
}

function matchCount(text, pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}

function extractHeadings(content) {
  const headings = [];
  const rx = /^(#{1,6})\s+(.+)$/gm;
  let match;
  while ((match = rx.exec(String(content || ''))) !== null) headings.push({ level: match[1].length, text: match[2].trim() });
  return headings;
}

function normalizeHeading(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sectionBigrams(keys) {
  if (keys.length <= 1) return [];
  const out = [];
  for (let i = 0; i < keys.length - 1; i++) out.push(`${keys[i]}>>${keys[i + 1]}`);
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function diceCoefficient(valuesA, valuesB) {
  const a = frequencyMap(valuesA);
  const b = frequencyMap(valuesB);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const [key, countA] of a.entries()) overlap += Math.min(countA, b.get(key) || 0);
  const total = [...a.values()].reduce((s, v) => s + v, 0) + [...b.values()].reduce((s, v) => s + v, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

function toDateOnly(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function daysAgo(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.floor((Date.now() - timestamp) / DAY_MS);
}

function sourceFromOpportunity(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return [];
  const sources = [];
  if (opportunity.source && typeof opportunity.source === 'object') sources.push(opportunity.source);
  if (Array.isArray(opportunity.sources)) {
    for (const source of opportunity.sources) {
      if (source && typeof source === 'object') sources.push(source);
    }
  }
  return sources;
}

function opportunitySeedTokens(opportunity) {
  const seedText = [
    opportunity?.term, opportunity?.seedTerm, opportunity?.suggestedTitle,
    opportunity?.rationale, opportunity?.pillarLabel, opportunity?.pillar,
  ].filter(Boolean).join(' ');
  return new Set(meaningfulWords(seedText));
}

function overlapScore(seedSet, text) {
  const tokens = new Set(meaningfulWords(text));
  if (seedSet.size === 0 || tokens.size === 0) return 0;
  let hits = 0;
  for (const token of seedSet) if (tokens.has(token)) hits++;
  return hits / seedSet.size;
}

function parseSlugFromUrl(url) {
  const match = String(url || '').match(/\/(?:post|guides?|fix)\/([a-z0-9][a-z0-9-]*[a-z0-9])/i);
  return match ? match[1].toLowerCase() : null;
}

export function calculateEntropyScore(article) {
  const content = String(article?.content || '');
  const tokens = meaningfulWords(content);
  if (tokens.length < 120) return 0;

  const uniqueRatio = new Set(tokens).size / tokens.length;
  const freq = frequencyMap(tokens);
  let hapax = 0;
  for (const count of freq.values()) if (count === 1) hapax++;
  const hapaxRatio = hapax / tokens.length;

  const sentenceLengths = splitSentences(content).map((s) => meaningfulWords(s).length).filter(Boolean);
  const paragraphLengths = splitParagraphs(content).map((p) => meaningfulWords(p).length).filter(Boolean);
  const sentenceCv = sentenceLengths.length > 1 ? stdDev(sentenceLengths) / Math.max(mean(sentenceLengths), 1) : 0;
  const paragraphCv = paragraphLengths.length > 1 ? stdDev(paragraphLengths) / Math.max(mean(paragraphLengths), 1) : 0;

  const topBigramShare = topShare(makeNgrams(tokens, 2));
  const topTrigramShare = topShare(makeNgrams(tokens, 3));

  let score = 0;
  score += clamp01((uniqueRatio - 0.22) / 0.25) * 34;
  score += clamp01((hapaxRatio - 0.15) / 0.30) * 14;
  score += clamp01(sentenceCv / 0.9) * 12;
  score += clamp01(paragraphCv / 1.1) * 8;
  score += clamp01(1 - (topBigramShare / 0.05)) * 12;
  score += clamp01(1 - (topTrigramShare / 0.035)) * 12;
  score += clamp01(countCodeBlocks(content) / 3) * 8;

  let clicheHits = 0;
  for (const pattern of AI_CLICHE_PATTERNS) clicheHits += matchCount(content, pattern);
  score -= Math.min(18, clicheHits * 3);

  return Math.round(clamp(score, 0, 100));
}

export function buildStructuralFingerprint(article) {
  const content = String(article?.content || '');
  const headings = extractHeadings(content);
  const h2Keys = headings.filter((h) => h.level === 2).map((h) => normalizeHeading(h.text)).filter(Boolean);
  const h3Keys = headings.filter((h) => h.level === 3).map((h) => normalizeHeading(h.text)).filter(Boolean);
  const headingTokens = new Set(meaningfulWords(h2Keys.concat(h3Keys).join(' ')));
  const titleTokens = new Set(meaningfulWords(article?.title || ''));
  const sectionBigramList = sectionBigrams(h2Keys);
  return { h2Count: h2Keys.length, h3Count: h3Keys.length, codeBlockCount: countCodeBlocks(content), checklistCount: countChecklistItems(content), sectionKeys: h2Keys, sectionBigrams: sectionBigramList, headingTokens, titleTokens };
}

export function compareStructuralSimilarity(a, b) {
  const headingDice = diceCoefficient(a.sectionBigrams, b.sectionBigrams);
  const headingSetOverlap = jaccard(new Set(a.sectionKeys), new Set(b.sectionKeys));
  const titleOverlap = jaccard(a.titleTokens, b.titleTokens);
  const headingTokenOverlap = jaccard(a.headingTokens, b.headingTokens);
  const maxShapeDelta = Math.max(Math.abs(a.h2Count - b.h2Count) + Math.abs(a.h3Count - b.h3Count) + Math.abs(a.codeBlockCount - b.codeBlockCount) + Math.abs(a.checklistCount - b.checklistCount), 1);
  const shapeSimilarity = 1 - clamp01(maxShapeDelta / 14);
  const score = headingDice * 0.38 + headingSetOverlap * 0.22 + headingTokenOverlap * 0.18 + titleOverlap * 0.08 + shapeSimilarity * 0.14;
  return Number(clamp(score, 0, 1).toFixed(3));
}

function shingleSet(text, size = 5) {
  const tokens = meaningfulWords(text);
  const shingles = new Set();
  if (tokens.length < size) return shingles;
  for (let i = 0; i <= tokens.length - size; i++) shingles.add(tokens.slice(i, i + size).join(' '));
  return shingles;
}

export function lexicalSimilarity(aContent, bContent) {
  const a = shingleSet(aContent);
  const b = shingleSet(bContent);
  return Number(jaccard(a, b).toFixed(3));
}

export function detectRepetitivePatterns(article) {
  const content = String(article?.content || '');
  const issues = [];
  let penalty = 0;

  let clicheHits = 0;
  for (const pattern of AI_CLICHE_PATTERNS) clicheHits += matchCount(content, pattern);
  if (clicheHits > 0) {
    penalty += Math.min(20, clicheHits * 4);
    issues.push({ field: 'style', severity: clicheHits > 2 ? 'critical' : 'warn', message: `Detected ${clicheHits} banned/generic AI phrase matches` });
  }

  const sentences = splitSentences(content);
  const starters = sentences.map((sentence) => meaningfulWords(sentence).slice(0, 3).join(' ')).filter((starter) => starter.split(' ').length >= 2);
  const starterFreq = frequencyMap(starters);
  let repeatedStarterCount = 0;
  let repeatedStarterSentenceCount = 0;
  let maxStarterCount = 0;
  for (const count of starterFreq.values()) {
    if (count > maxStarterCount) maxStarterCount = count;
    if (count >= 3) repeatedStarterCount++;
    if (count >= 3) repeatedStarterSentenceCount += count;
  }
  if (repeatedStarterCount > 0) {
    const totalSentences = Math.max(sentences.length, 1);
    const topStarterShare = maxStarterCount / totalSentences;
    const repeatedStarterShare = repeatedStarterSentenceCount / totalSentences;
    const starterPenalty = Math.round(clamp((repeatedStarterShare * 14) + (topStarterShare * 8), 4, 18));
    penalty += starterPenalty;
    const criticalStarterDominance = topStarterShare >= 0.28 || repeatedStarterShare >= 0.88;
    issues.push({ field: 'sentenceVariety', severity: criticalStarterDominance ? 'critical' : 'warn', message: `${repeatedStarterCount} sentence starters repeat 3+ times` });
  }

  const words = meaningfulWords(content);
  const trigramShare = topShare(makeNgrams(words, 3));
  if (trigramShare >= 0.04) {
    penalty += 12;
    issues.push({ field: 'nGramRepetition', severity: 'critical', message: `Top trigram share too high (${(trigramShare * 100).toFixed(1)}%)` });
  } else if (trigramShare >= 0.03) {
    penalty += 6;
    issues.push({ field: 'nGramRepetition', severity: 'warn', message: `Top trigram share elevated (${(trigramShare * 100).toFixed(1)}%)` });
  }

  return { penalty: Math.round(penalty), issues };
}

function isLikelyStackTrace(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^\s*at\s+.+\(.+\)\s*$/m.test(value)) return true;
  if (/\/[A-Za-z0-9._-]+\.js:\d+:\d+/m.test(value)) return true;
  if (/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|RuntimeError|Exception)\b/i.test(value)) return true;
  return false;
}

function hasIncidentContext(opportunity, source) {
  const text = [
    opportunity?.suggestedTitle, opportunity?.title, opportunity?.rationale,
    opportunity?.description, source?.title, source?.query, source?.excerpt,
    source?.question, source?.questionText,
  ].filter(Boolean).join(' ');
  return INCIDENT_CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function countGroundingArtifacts(source) {
  if (!source || typeof source !== 'object') return 0;
  const type = source.type;
  if (type === 'github-issue') {
    let count = 0;
    if (typeof source.url === 'string' && /github\.com\/.+\/issues\/\d+/i.test(source.url)) count++;
    if (String(source.excerpt || '').trim().length >= 24) count++;
    return count;
  }
  if (type === 'stack-overflow') {
    let count = 0;
    if (typeof source.url === 'string' && /stackoverflow\.com\/questions\//i.test(source.url)) count++;
    if (String(source.question || source.questionText || source.title || source.excerpt || '').trim().length >= 24) count++;
    return count;
  }
  if (type === 'error-log') {
    let count = 0;
    const excerpt = String(source.excerpt || '').trim();
    if (excerpt.length >= 24) count++;
    if (isLikelyStackTrace(source.stackTrace || excerpt)) count++;
    return count;
  }
  if (type === 'gsc') {
    let count = 0;
    if (String(source.query || '').trim().length > 0) count++;
    if (String(source.keyword || source.impressionKeyword || source.term || '').trim().length > 0) count++;
    if (typeof source.impressions === 'number' && source.impressions > 0) count++;
    return count;
  }
  if (type === 'topic-map') {
    let count = 0;
    if (String(source.term || source.seedTerm || '').trim().length > 0) count++;
    if (String(source.rationale || '').trim().length >= 20) count++;
    return count;
  }
  return 0;
}

function bestPageQuery(gscCache, pageUrl) {
  const rows = Array.isArray(gscCache?.pageQueries?.[pageUrl]) ? gscCache.pageQueries[pageUrl] : [];
  return rows.filter((row) => row && typeof row.query === 'string' && row.query.trim())
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))[0] || null;
}

export function validateGroundingSource(source) {
  const issues = [];
  if (!source || typeof source !== 'object') {
    return { ok: false, issues: [{ field: 'source', severity: 'critical', message: 'Missing source evidence' }] };
  }

  const type = source.type;
  if (!SOURCE_TYPES.has(type)) {
    issues.push({ field: 'source.type', severity: 'critical', message: `Unsupported source type "${type || '(empty)'}"` });
  }

  if (type === 'gsc') {
    const hasQuery = typeof source.query === 'string' && source.query.trim().length > 0;
    const hasImpressionKeyword = typeof source.keyword === 'string' && source.keyword.trim().length > 0
      || typeof source.impressionKeyword === 'string' && source.impressionKeyword.trim().length > 0
      || typeof source.term === 'string' && source.term.trim().length > 0;
    if (!hasQuery && !hasImpressionKeyword) issues.push({ field: 'source.gsc', severity: 'critical', message: 'GSC source must include query or impression keyword' });
    if (typeof source.impressions !== 'number' || source.impressions < 1) issues.push({ field: 'source.impressions', severity: 'critical', message: 'GSC source must include impressions > 0' });
  }

  if (type === 'stack-overflow') {
    const validUrl = typeof source.url === 'string' && /stackoverflow\.com\/questions\//i.test(source.url);
    const hasQuestionText = String(source.question || source.questionText || source.title || source.excerpt || '').trim().length >= 24;
    if (source.url && !validUrl) issues.push({ field: 'source.url', severity: 'critical', message: 'Stack Overflow source must include a questions URL' });
    if (!hasQuestionText) issues.push({ field: 'source.question', severity: 'critical', message: 'Stack Overflow source must include real question text' });
    if (!validUrl && !source.questionId) issues.push({ field: 'source.stackoverflow', severity: 'critical', message: 'Stack Overflow source must include a real URL or question id' });
  }

  if (type === 'github-issue') {
    const validUrl = typeof source.url === 'string' && /github\.com\/.+\/issues\/\d+/i.test(source.url);
    const excerpt = String(source.excerpt || '').trim();
    const hasExcerpt = excerpt.length >= 24;
    if (source.url && !validUrl) issues.push({ field: 'source.url', severity: 'critical', message: 'GitHub issue URL must point to an issue resource' });
    if (!validUrl && !hasExcerpt) issues.push({ field: 'source.github', severity: 'critical', message: 'GitHub issue source must include a valid issue URL or real excerpt' });
  }

  if (type === 'error-log') {
    const excerpt = String(source.excerpt || '').trim();
    const stackTrace = String(source.stackTrace || '').trim();
    if (excerpt.length < 24 && stackTrace.length < 24) {
      issues.push({ field: 'source.excerpt', severity: 'critical', message: 'Error-log source must include stack trace or meaningful snippet' });
    } else if (!isLikelyStackTrace(stackTrace || excerpt)) {
      issues.push({ field: 'source.stackTrace', severity: 'critical', message: 'Error-log source must include recognizable error/stack evidence' });
    }
  }

  if (type === 'topic-map') {
    const hasTerm = String(source.term || source.seedTerm || '').trim().length >= 3;
    const hasRationale = String(source.rationale || '').trim().length >= 20;
    if (!hasTerm && !hasRationale) issues.push({ field: 'source.topic-map', severity: 'critical', message: 'topic-map source must include a term or rationale' });
  }

  return { ok: issues.length === 0, issues };
}

function pickBestGscSource(opportunity, gscCache) {
  if (!gscCache) return null;
  const seeds = opportunitySeedTokens(opportunity);
  if (seeds.size === 0) return null;

  const gaps = keywordGaps(gscCache, { minImpressions: 25, maxClicks: 2 });
  let bestGap = null;
  let bestGapScore = 0;
  for (const gap of gaps) {
    const score = overlapScore(seeds, gap.query);
    if (score > bestGapScore) { bestGap = gap; bestGapScore = score; }
  }

  const pages = lowCtrPages(gscCache, { minImpressions: 75, maxCtr: 0.06 });
  let bestPage = null;
  let bestPageScore = 0;
  for (const page of pages) {
    const score = overlapScore(seeds, page.url);
    if (score > bestPageScore) { bestPage = page; bestPageScore = score; }
  }

  const gapWins = bestGap && bestGapScore >= 0.35;
  const pageWins = bestPage && bestPageScore >= 0.35;

  if (gapWins) {
    const targetUrl = Array.isArray(bestGap.pages) && bestGap.pages.length > 0 ? bestGap.pages[0] : null;
    return { type: 'gsc', query: bestGap.query, pageUrl: targetUrl || undefined, impressions: bestGap.impressions, clicks: bestGap.clicks, ctr: bestGap.ctr, position: bestGap.position, observedAt: gscCache.fetchedAt, evidenceStrength: Number(bestGapScore.toFixed(3)), slugHint: targetUrl ? parseSlugFromUrl(targetUrl) : null };
  }

  if (pageWins) {
    const query = bestPageQuery(gscCache, bestPage.url);
    return { type: 'gsc', pageUrl: bestPage.url, query: query?.query, impressions: bestPage.impressions, clicks: bestPage.clicks, ctr: bestPage.ctr, position: bestPage.position, observedAt: gscCache.fetchedAt, evidenceStrength: Number(bestPageScore.toFixed(3)), slugHint: parseSlugFromUrl(bestPage.url) };
  }

  return null;
}

export function resolveGroundingSource(opportunity, options = {}) {
  const fromOpportunity = sourceFromOpportunity(opportunity);
  for (const source of fromOpportunity) {
    const validation = validateGroundingSource(source);
    if (validation.ok) return source;
  }
  if (fromOpportunity.length > 0) return null;

  const gscCache = options.gscCache || loadGscCache();
  const gscSource = pickBestGscSource(opportunity, gscCache);
  if (gscSource) {
    const validation = validateGroundingSource(gscSource);
    if (validation.ok) return gscSource;
  }

  const allowTopicMapFallback = options.allowTopicMapFallback === true;
  if (allowTopicMapFallback) {
    const hasExplicitSource = (opportunity?.source && typeof opportunity.source === 'object') || (Array.isArray(opportunity?.sources) && opportunity.sources.length > 0);
    if (!hasExplicitSource) {
      const term = String(opportunity?.seedTerm || opportunity?.term || opportunity?.suggestedTitle || '').trim();
      const rationale = String(opportunity?.rationale || opportunity?.description || '').trim();
      if (term.length > 0 || rationale.length >= 20) return { type: 'topic-map', term, rationale, pillar: opportunity?.pillar || null };
    }
  }

  return null;
}

export function validateGrounding(opportunity, options = {}) {
  const issues = [];
  const title = String(opportunity?.suggestedTitle || opportunity?.title || '').trim();
  const explicitSources = sourceFromOpportunity(opportunity);
  let source = null;

  if (explicitSources.length > 0) {
    for (const candidate of explicitSources) {
      const validation = validateGroundingSource(candidate);
      if (validation.ok) { source = candidate; break; }
      issues.push(...validation.issues);
    }
  } else {
    source = resolveGroundingSource(opportunity, { gscCache: options.gscCache, allowTopicMapFallback: true });
  }

  if (!source) {
    return { ok: false, source: null, issues: issues.length > 0 ? issues : [{ field: 'source', severity: 'critical', message: 'Missing grounding source with real evidence' }], artifactCount: 0, hasIncidentContext: false, genericTitle: STRICT_GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(title)) };
  }

  const sourceValidation = validateGroundingSource(source);
  if (!sourceValidation.ok) issues.push(...sourceValidation.issues);

  const genericTitle = STRICT_GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const incidentContext = hasIncidentContext(opportunity, source);
  const artifactCount = countGroundingArtifacts(source);

  if (artifactCount < 1) issues.push({ field: 'source.artifact', severity: 'critical', message: 'Grounding source does not contain any real-world artifact' });
  if (!incidentContext) issues.push({ field: 'incidentContext', severity: 'critical', message: 'Opportunity lacks concrete incident context (error/symptom/log)' });
  if (genericTitle && !incidentContext) issues.push({ field: 'title.generic', severity: 'critical', message: `Generic title without evidence-backed incident context: "${title}"` });

  return { ok: issues.length === 0, source, issues, artifactCount, hasIncidentContext: incidentContext, genericTitle };
}

function detectGenericSignals(article) {
  const issues = [];
  const title = String(article?.title || '');
  const content = String(article?.content || '');

  for (const pattern of GENERIC_SEO_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      issues.push({ field: 'title.generic', severity: 'warn', message: `Title pattern looks generic/spam-prone: "${title}"` });
      break;
    }
  }

  for (const pattern of PHRASE_BANNERS) {
    if (pattern.test(content)) {
      issues.push({ field: 'content.placeholder', severity: 'critical', message: 'Template placeholders or TODO markers detected' });
      break;
    }
  }

  const codeBlocks = countCodeBlocks(content);
  if (codeBlocks < 2) issues.push({ field: 'content.code', severity: 'warn', message: `Only ${codeBlocks} code block(s); thin practical signal` });

  const internalLinks = (content.match(/\[[^\]]+\]\(\/(?:post|guides?|fix)\/[a-z0-9-]+\)/gi) || []).length;
  if (internalLinks < 3) issues.push({ field: 'content.internalLinks', severity: 'warn', message: `Only ${internalLinks} inline internal links` });

  return issues;
}

function recentWindow(items, maxDays = 7) {
  return items.filter((item) => daysAgo(item.date || item.modifiedDate || item.generatedAt) <= maxDays);
}

function introPattern(content) {
  const sentence = splitSentences(content)[0] || '';
  return meaningfulWords(sentence).slice(0, 8).join(' ');
}

function sectionSnippet(content, headingText) {
  const body = String(content || '');
  const rx = new RegExp(`^##\\s+${headingText}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'im');
  const match = body.match(rx);
  if (!match) return '';
  return meaningfulWords(match[1]).slice(0, 28).join(' ');
}

function sameSequencePattern(a, b, c) {
  if (!a || !b || !c) return false;
  return a === b && b === c;
}

function diversityIssues(article, context) {
  const issues = [];
  const inventory = Array.isArray(context.inventory) ? context.inventory : [];
  const recentGenerated = Array.isArray(context.recentGenerated) ? context.recentGenerated : [];
  const seed = [...recentWindow(inventory, 7), ...recentWindow(recentGenerated, 7)];
  const byDay = new Map();
  for (const item of seed) {
    const day = toDateOnly(item.date || item.modifiedDate || item.generatedAt);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  }

  const articleDay = toDateOnly(article.date || article.generatedAt || new Date().toISOString());
  const sameDay = byDay.get(articleDay) || [];
  const cls = classify(article);

  const samePillar = sameDay.filter((item) => classify(item).pillar === cls.pillar).length;
  if (cls.pillar && samePillar >= 2) issues.push({ field: 'diversity.pillar', severity: 'critical', message: `Would publish >2 pieces in pillar "${cls.pillar}" on ${articleDay}` });

  const sameIntent = sameDay.filter((item) => classify(item).intent === cls.intent).length;
  if (sameIntent >= 2) issues.push({ field: 'diversity.intent', severity: 'warn', message: `Intent "${cls.intent}" already dominates ${articleDay}` });

  const lastTwo = recentGenerated.slice(-2);
  if (lastTwo.length === 2) {
    const a = classify(lastTwo[0]);
    const b = classify(lastTwo[1]);
    if (a.intent === cls.intent && b.intent === cls.intent) issues.push({ field: 'diversity.sequence', severity: 'warn', message: `Three consecutive "${cls.intent}" pieces in one batch` });

    const currentFingerprint = buildStructuralFingerprint(article);
    const firstSimilarity = compareStructuralSimilarity(currentFingerprint, buildStructuralFingerprint(lastTwo[0]));
    const secondSimilarity = compareStructuralSimilarity(currentFingerprint, buildStructuralFingerprint(lastTwo[1]));
    const currentIntro = introPattern(article.content);
    const firstIntro = introPattern(lastTwo[0].content);
    const secondIntro = introPattern(lastTwo[1].content);
    const currentFix = sectionSnippet(article.content, 'Fix');
    const firstFix = sectionSnippet(lastTwo[0].content, 'Fix');
    const secondFix = sectionSnippet(lastTwo[1].content, 'Fix');

    if (firstSimilarity >= 0.82 && secondSimilarity >= 0.82 && sameSequencePattern(currentIntro, firstIntro, secondIntro) && sameSequencePattern(currentFix, firstFix, secondFix)) {
      issues.push({ field: 'diversity.sequencePattern', severity: 'critical', message: 'Three consecutive drafts share structure, intro, and fix patterns' });
    }
  }

  return issues;
}

function compareAgainstCorpus(article, context) {
  const inventory = Array.isArray(context.inventory) ? context.inventory : [];
  const recentGenerated = Array.isArray(context.recentGenerated) ? context.recentGenerated : [];
  const corpus = [...inventory, ...recentGenerated].filter((item) => item && item.content && item.slug !== article.slug);
  if (!corpus.length) return { maxStructuralSimilarity: 0, maxLexicalSimilarity: 0, closestStructuralSlug: null, closestLexicalSlug: null };

  const currentFingerprint = buildStructuralFingerprint(article);
  let maxStructural = 0;
  let maxLexical = 0;
  let structuralSlug = null;
  let lexicalSlug = null;

  for (const candidate of corpus) {
    const structural = compareStructuralSimilarity(currentFingerprint, buildStructuralFingerprint(candidate));
    if (structural > maxStructural) { maxStructural = structural; structuralSlug = candidate.slug || null; }
    const lexical = lexicalSimilarity(article.content, candidate.content);
    if (lexical > maxLexical) { maxLexical = lexical; lexicalSlug = candidate.slug || null; }
  }

  return { maxStructuralSimilarity: Number(maxStructural.toFixed(3)), maxLexicalSimilarity: Number(maxLexical.toFixed(3)), closestStructuralSlug: structuralSlug, closestLexicalSlug: lexicalSlug };
}

export function assessArticle(article, context = {}) {
  const issues = [];
  const minEntropyScore = context.minEntropyScore ?? 58;
  const minSeoScore = context.minSeoScore ?? 70;
  const maxStructuralSimilarity = context.maxStructuralSimilarity ?? 0.85;
  const maxLexicalSimilarity = context.maxLexicalSimilarity ?? 0.74;
  const maxPatternPenalty = context.maxPatternPenalty ?? 18;

  const entropyScore = calculateEntropyScore(article);
  if (entropyScore < minEntropyScore) issues.push({ field: 'entropy', severity: 'critical', message: `Entropy score ${entropyScore} < ${minEntropyScore}` });

  const patternCheck = detectRepetitivePatterns(article);
  issues.push(...patternCheck.issues);
  if (patternCheck.penalty > maxPatternPenalty) issues.push({ field: 'patternPenalty', severity: 'critical', message: `Pattern penalty ${patternCheck.penalty} > ${maxPatternPenalty}` });

  const seo = scoreItem(article, article.kind || 'post');
  if (seo.score < minSeoScore) issues.push({ field: 'seoScore', severity: 'critical', message: `SEO score ${seo.score} < ${minSeoScore}` });

  issues.push(...detectGenericSignals(article));
  issues.push(...diversityIssues(article, context));

  const source = article.source || resolveGroundingSource(context.opportunity, { gscCache: context.gscCache });
  const sourceValidation = validateGroundingSource(source);
  if (!sourceValidation.ok) issues.push(...sourceValidation.issues);

  const corpus = compareAgainstCorpus(article, context);
  if (corpus.maxStructuralSimilarity >= maxStructuralSimilarity) {
    issues.push({ field: 'structureSimilarity', severity: 'critical', message: `Structural similarity ${corpus.maxStructuralSimilarity} >= ${maxStructuralSimilarity} (closest: ${corpus.closestStructuralSlug || 'unknown'})` });
  } else if (corpus.maxStructuralSimilarity >= maxStructuralSimilarity - 0.06) {
    issues.push({ field: 'structureSimilarity', severity: 'warn', message: `Structural similarity high (${corpus.maxStructuralSimilarity})` });
  }

  if (corpus.maxLexicalSimilarity >= maxLexicalSimilarity) {
    issues.push({ field: 'lexicalSimilarity', severity: 'critical', message: `Lexical similarity ${corpus.maxLexicalSimilarity} >= ${maxLexicalSimilarity} (closest: ${corpus.closestLexicalSlug || 'unknown'})` });
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const decision = criticalCount > 0 ? (criticalCount >= 3 ? 'reject' : 'retry') : 'approve';

  return { pass: criticalCount === 0, decision, issues, source, metrics: { entropyScore, patternPenalty: patternCheck.penalty, seoScore: seo.score, structuralSimilarity: corpus.maxStructuralSimilarity, lexicalSimilarity: corpus.maxLexicalSimilarity, closestStructuralSlug: corpus.closestStructuralSlug, closestLexicalSlug: corpus.closestLexicalSlug } };
}

export function createDiversitySnapshot(seedItems = []) {
  const snapshot = { byDay: {}, recent: [] };
  for (const item of seedItems) updateDiversitySnapshot(snapshot, item);
  return snapshot;
}

export function updateDiversitySnapshot(snapshot, article) {
  const target = snapshot || createDiversitySnapshot();
  const day = toDateOnly(article?.date || article?.generatedAt || new Date().toISOString());
  if (!day) return target;
  if (!target.byDay[day]) target.byDay[day] = { total: 0, pillars: {}, intents: {} };
  const cls = classify(article || {});
  const bucket = target.byDay[day];
  bucket.total += 1;
  const pillarKey = cls.pillar || '__unclassified';
  bucket.pillars[pillarKey] = (bucket.pillars[pillarKey] || 0) + 1;
  bucket.intents[cls.intent] = (bucket.intents[cls.intent] || 0) + 1;
  target.recent.push({ slug: article?.slug, date: day, pillar: cls.pillar, intent: cls.intent, sourceType: article?.source?.type || null });
  if (target.recent.length > 20) target.recent.shift();
  return target;
}
