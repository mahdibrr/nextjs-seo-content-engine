#!/usr/bin/env node
// content-opportunities.js — surfaces specific pages to publish.
//
// Three kinds of opportunities:
//   1. Missing canonical terms
//   2. Missing intent variants
//   3. Under-served clusters

import '../src/lib/content-engine/bootstrap-env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

import { PILLARS, classify } from '../src/lib/content-engine/topic-map.js';
import { buildClusters } from '../src/lib/content-engine/keyword-clusters.js';
import { loadGscCache, keywordGaps, lowCtrPages } from '../src/lib/content-engine/gsc-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content/posts');
const GUIDES_DIR = path.join(ROOT, 'content/guides');
const FIXES_DIR = path.join(ROOT, 'content/fixes');
const OUTPUT = path.join(ROOT, 'docs/content-opportunities.json');

const OFF_TOPIC_SLUGS = new Set(
  (process.env.OFF_TOPIC_SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

function loadDir(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mdx') || f.endsWith('.md'))
    .map((f) => {
      const { data, content } = matter(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { slug: f.replace(/\.(mdx|md)$/, ''), kind, content, ...data };
    });
}

const INTENT_VARIANTS = [
  { id: 'troubleshooting', template: 'Fix "{term}" not working in production' },
  { id: 'comparison', template: '{term} vs alternatives in 2026' },
  { id: 'migration', template: 'Migrating to {term} from a legacy setup' },
  { id: 'implementation', template: 'How to implement {term} end to end' },
  { id: 'checklist', template: '{term} production checklist' },
];

const DEV_SYMPTOM_PATTERNS = [
  /\berror\b/i, /\bexception\b/i, /\bnot working\b/i, /\bfail(?:s|ed|ing)?\b/i,
  /\bdisable(?:d|s|ing)?\b/i, /\bstuck\b/i, /\bredirect(?:s|ed|ing)?\b/i,
  /\bproduction build\b/i, /\bcrash(?:ed|ing)?\b/i, /\btimeout\b/i, /\bslow\b/i, /\b500\b/i,
];

function findIntentCoverage(items, pillar) {
  const intents = new Set();
  for (const item of items) {
    const { pillar: itemPillar, intent } = classify(item);
    if (itemPillar === pillar && intent) intents.add(intent);
  }
  return intents;
}

function normalizeTokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
}

function overlapScore(seedSet, text) {
  const tokens = normalizeTokens(text);
  if (seedSet.size === 0 || tokens.size === 0) return 0;
  let hits = 0;
  for (const token of seedSet) if (tokens.has(token)) hits++;
  return hits / seedSet.size;
}

function hasDevSymptom(text) {
  return DEV_SYMPTOM_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

function titleCase(text) {
  return String(text || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === 'next.js' || lower === 'nextjs') return 'Next.js';
      if (lower === 'supabase') return 'Supabase';
      if (lower === 'api') return 'API';
      if (lower === 'rls') return 'RLS';
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
}

function titleFromGscQuery(query) {
  const cleaned = String(query || '').replace(/\s+/g, ' ').trim();
  if (/^fix\b/i.test(cleaned)) return titleCase(cleaned);
  if (/not working|error|fail|stuck|crash|timeout|500/i.test(cleaned)) return `Fix ${titleCase(cleaned)}`;
  return titleCase(cleaned);
}

function bestPageQuery(gscCache, pageUrl) {
  const rows = Array.isArray(gscCache?.pageQueries?.[pageUrl]) ? gscCache.pageQueries[pageUrl] : [];
  return rows.filter((row) => row && typeof row.query === 'string' && row.query.trim())
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))[0] || null;
}

function buildGscOpportunities(gscCache) {
  if (!gscCache) return [];
  const opportunities = [];
  const seen = new Set();

  function addFromMetric(metric, kind, pageUrl) {
    const query = String(metric?.query || '').trim();
    if (!query || !hasDevSymptom(query)) return;
    const dedupeKey = query.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const classified = classify({ title: query, content: [query, pageUrl].filter(Boolean).join(' '), tags: [], keywords: [query] });
    const pillar = classified.pillar || 'nextjs-supabase';
    const impressions = Number(metric.impressions || 0);
    opportunities.push({
      kind, priority: 150 + Math.min(40, Math.round(Math.log10(impressions + 1) * 10)),
      pillar, pillarLabel: PILLARS[pillar]?.label || titleCase(pillar),
      term: query, suggestedTitle: titleFromGscQuery(query),
      rationale: `Search Console shows real demand for "${query}" (${impressions} impressions).`,
      suggestedIntent: 'troubleshooting',
      source: { type: 'gsc', query, pageUrl: pageUrl || metric.pageUrl || undefined, impressions, clicks: Number(metric.clicks || 0), ctr: Number(metric.ctr || 0), position: Number(metric.position || 0), observedAt: gscCache.fetchedAt, evidenceStrength: 1 },
    });
  }

  for (const gap of keywordGaps(gscCache, { minImpressions: 25, maxClicks: 2 }).slice(0, 30)) {
    const pageUrl = Array.isArray(gap.pages) && gap.pages.length > 0 ? gap.pages[0] : undefined;
    addFromMetric(gap, 'gsc-keyword-gap', pageUrl);
  }
  for (const page of lowCtrPages(gscCache, { minImpressions: 75, maxCtr: 0.06 }).slice(0, 30)) {
    const query = bestPageQuery(gscCache, page.url);
    if (!query) continue;
    addFromMetric(query, 'gsc-low-ctr-page', page.url);
  }
  return opportunities;
}

function main() {
  const gscCache = loadGscCache();
  const posts = loadDir(POSTS_DIR, 'post').filter((p) => !OFF_TOPIC_SLUGS.has(p.slug));
  const guides = loadDir(GUIDES_DIR, 'guide');
  const fixes = loadDir(FIXES_DIR, 'fix');
  const all = [...posts, ...guides, ...fixes];
  const clusters = buildClusters(all);

  const opportunities = [];
  opportunities.push(...buildGscOpportunities(gscCache));

  const TERM_TITLE_TEMPLATES = {
    troubleshooting: (term) => `Fix ${titleCase(term)} Not Working in Production`,
    implementation:  (term) => `How to Set Up ${titleCase(term)} (Step by Step)`,
    migration:       (term) => `Migrating to ${titleCase(term)}: What the Docs Don't Tell You`,
    comparison:      (term) => `${titleCase(term)} vs Alternatives: 2026 Breakdown`,
    checklist:       (term) => `${titleCase(term)} Production Checklist`,
    guide:           (term) => `${titleCase(term)} in Production: The Real-World Guide`,
  };

  for (const [pillarKey, pillar] of Object.entries(PILLARS)) {
    const cluster = clusters[pillarKey];
    if (!cluster) continue;
    for (const term of cluster.missing) {
      const intent = pillar.intents[0] || 'guide';
      const titleFn = TERM_TITLE_TEMPLATES[intent] || TERM_TITLE_TEMPLATES.guide;
      const title = titleFn(term).slice(0, 60);
      opportunities.push({ kind: 'missing-term', priority: Math.round(pillar.weight * 100), pillar: pillarKey, pillarLabel: pillar.label, term, suggestedTitle: title, rationale: `Pillar "${pillar.label}" has no page covering "${term}".`, suggestedIntent: intent });
    }
  }

  for (const [pillarKey, pillar] of Object.entries(PILLARS)) {
    const cluster = clusters[pillarKey];
    if (!cluster) continue;
    const intentsHave = findIntentCoverage(cluster.items, pillarKey);
    const missingIntents = pillar.intents.filter((i) => !intentsHave.has(i));
    for (const intent of missingIntents) {
      const topCoveredTerm = Object.entries(cluster.terms).filter(([, v]) => v.count > 0).sort((a, b) => b[1].count - a[1].count)[0];
      const seedTerm = topCoveredTerm ? topCoveredTerm[0] : pillar.label;
      const template = (INTENT_VARIANTS.find((v) => v.id === intent) || INTENT_VARIANTS[0]).template;
      opportunities.push({ kind: 'missing-intent', priority: Math.round(pillar.weight * 80), pillar: pillarKey, pillarLabel: pillar.label, intent, seedTerm, suggestedTitle: template.replace('{term}', seedTerm), rationale: `Pillar "${pillar.label}" has no "${intent}" content.`, suggestedIntent: intent });
    }
  }

  const MIN_PIECES_PER_PILLAR = 6;
  for (const [pillarKey, pillar] of Object.entries(PILLARS)) {
    const cluster = clusters[pillarKey];
    if (!cluster || cluster.items.length >= MIN_PIECES_PER_PILLAR) continue;
    const deficit = MIN_PIECES_PER_PILLAR - cluster.items.length;
    opportunities.push({ kind: 'underserved-cluster', priority: Math.round(pillar.weight * 90) + deficit * 5, pillar: pillarKey, pillarLabel: pillar.label, have: cluster.items.length, need: MIN_PIECES_PER_PILLAR, rationale: `Pillar "${pillar.label}" has only ${cluster.items.length} pieces (target ${MIN_PIECES_PER_PILLAR}).` });
  }

  opportunities.sort((a, b) => b.priority - a.priority);

  function slugFromTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  }
  const seenSlugs = new Set();
  const deduped = opportunities.filter((op) => {
    const slug = op.suggestedSlug || slugFromTitle(op.suggestedTitle);
    if (!slug || seenSlugs.has(slug)) return false;
    seenSlugs.add(slug);
    return true;
  });

  const summary = {
    total: deduped.length,
    byKind: deduped.reduce((acc, o) => { acc[o.kind] = (acc[o.kind] || 0) + 1; return acc; }, {}),
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify({ summary, opportunities: deduped }, null, 2));

  console.log('Content opportunities');
  console.log(`Total: ${summary.total}`);
  for (const [k, v] of Object.entries(summary.byKind)) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`\nTop 5:`);
  for (const op of deduped.slice(0, 5)) {
    console.log(`  • [${op.priority}] ${op.suggestedTitle || op.rationale}`);
  }
  console.log(`\nFull report: ${path.relative(ROOT, OUTPUT)}`);
}

main();
