#!/usr/bin/env node
// seo-score.js — scores every post and guide, writes docs/seo-report.json.
//
// Usage:
//   node scripts/seo-score.js
//   node scripts/seo-score.js --threshold=60
//   node scripts/seo-score.js --json

import '../src/lib/content-engine/bootstrap-env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

import { scoreItem } from '../src/lib/content-engine/content-scoring.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content/posts');
const GUIDES_DIR = path.join(ROOT, 'content/guides');
const FIXES_DIR = path.join(ROOT, 'content/fixes');
const OUTPUT = path.join(ROOT, 'docs/seo-report.json');

const OFF_TOPIC_SLUGS = new Set(
  (process.env.OFF_TOPIC_SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

function parseArgs(argv) {
  const args = { json: false, threshold: Number(process.env.SEO_THRESHOLD || 0) };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a.startsWith('--threshold=')) args.threshold = Number(a.split('=')[1]);
  }
  return args;
}

function loadDir(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mdx') || f.endsWith('.md'))
    .map((f) => {
      const { data, content } = matter(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { slug: f.replace(/\.(mdx|md)$/, ''), kind, content, ...data };
    });
}

function bucket(score) {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 55) return 'fair';
  if (score >= 40) return 'poor';
  return 'critical';
}

function main() {
  const args = parseArgs(process.argv);
  const posts = loadDir(POSTS_DIR, 'post').filter((p) => !OFF_TOPIC_SLUGS.has(p.slug));
  const guides = loadDir(GUIDES_DIR, 'guide');
  const fixes = loadDir(FIXES_DIR, 'fix');

  const scored = [
    ...posts.map((p) => scoreItem(p, 'post')),
    ...guides.map((g) => scoreItem(g, 'guide')),
    ...fixes.map((f) => scoreItem(f, 'fix')),
  ].sort((a, b) => a.score - b.score);

  const buckets = scored.reduce((acc, r) => {
    const k = bucket(r.score);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const avg = scored.length
    ? Number((scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(2))
    : 0;

  const offendersBy = (key) => scored
    .filter((r) => r.breakdown[key] != null)
    .sort((a, b) => a.breakdown[key] - b.breakdown[key])
    .slice(0, 5)
    .map((r) => ({ slug: r.slug, kind: r.kind, score: r.breakdown[key], total: r.score }));

  const summary = {
    scanned: scored.length,
    mean: avg,
    buckets,
    worstOffendersByDimension: {
      title: offendersBy('title'),
      description: offendersBy('description'),
      length: offendersBy('length'),
      internalLinks: offendersBy('internalLinks'),
      topical: offendersBy('topical'),
    },
    generatedAt: new Date().toISOString(),
  };

  const report = { summary, items: scored };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));

  if (args.json) { process.stdout.write(JSON.stringify(report, null, 2)); return; }

  console.log('==============================================');
  console.log(`SEO score — ${summary.scanned} articles, mean ${avg}/100`);
  console.log('==============================================');
  for (const [b, n] of Object.entries(buckets)) console.log(`  ${b.padEnd(10)} ${n}`);
  console.log('\nBottom 10:');
  for (const r of scored.slice(0, 10)) {
    console.log(`  [${r.score}] [${r.kind}] ${r.slug}`);
    const topIssue = r.issues.find((i) => i.severity === 'critical') || r.issues[0];
    if (topIssue) console.log(`      ${topIssue.field}: ${topIssue.message}`);
  }
  console.log(`\nFull report: ${path.relative(ROOT, OUTPUT)}`);

  if (args.threshold > 0 && avg < args.threshold) {
    console.error(`\nFAIL: mean ${avg} below threshold ${args.threshold}.`);
    process.exit(1);
  }
}

main();
