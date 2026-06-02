// SEO optimizer — applies safe, deterministic improvements to existing MDX files.
//
// Operations:
//   1. fixTitleLength       — shorten titles past 60 chars
//   2. fixMetaLength        — pad short descriptions
//   3. fillMissingKeywords  — add up to 3 keywords from title + pillar
//   4. fillMissingTags      — add the pillar key as a tag when tags < 2
//   5. injectInternalLinks  — append a "Related" section with 3 link suggestions
//   6. addModifiedDate      — set modifiedDate to today if missing

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { classify, PILLARS, asArray } from './topic-map.js';
import { extractInternalLinkSlugs, suggestLinksFor, anchorFor, buildHubIndex } from './internal-linking.js';

const TODAY = () => new Date().toISOString().slice(0, 10);

// Slug patterns to exclude from optimization (noindex content).
// Pass via options.offTopicSlugs or set OFF_TOPIC_SLUGS env var (comma-separated).
function getOffTopicSlugs(options = {}) {
  if (options.offTopicSlugs instanceof Set) return options.offTopicSlugs;
  const env = process.env.OFF_TOPIC_SLUGS || '';
  return new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
}

export function loadInventory(options = {}) {
  const root = options.root || process.cwd();
  const postsDir = options.postsDir || path.join(root, 'content/posts');
  const guidesDir = options.guidesDir || path.join(root, 'content/guides');
  const fixesDir = options.fixesDir || path.join(root, 'content/fixes');
  const offTopicSlugs = getOffTopicSlugs(options);

  function loadDir(dir, kind) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mdx') || f.endsWith('.md'))
      .map((f) => {
        const { data, content } = matter(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { slug: f.replace(/\.(mdx|md)$/, ''), kind, content, ...data };
      });
  }

  const posts = loadDir(postsDir, 'post').filter((p) => !offTopicSlugs.has(p.slug));
  const guides = loadDir(guidesDir, 'guide');
  const fixes = loadDir(fixesDir, 'fix');
  return { posts, guides, fixes, all: [...posts, ...guides, ...fixes] };
}

function shortenTitleSafely(title) {
  if (!title) return title;
  const out = title
    .replace(/\s+in\s+20\d{2}\b/gi, '')
    .replace(/\s+20\d{2}\b/gi, '')
    .replace(/\bComplete Guide to\b/gi, 'Guide to')
    .replace(/\bComplete Guide\b/gi, 'Guide')
    .replace(/\bThe Complete\b/gi, '')
    .replace(/\bDefinitive\b/gi, '')
    .replace(/\bProduction Guide\b/gi, 'Guide')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (out === title) return title;
  if (out.length <= 60) return out;
  return title;
}

function fillDescription(description, title) {
  if (!description) {
    return `${title}. Practical, code-backed walkthrough — what to do, what to avoid, and how to verify.`;
  }
  if (description.length < 110) {
    return `${description.trim()} — practical, code-backed walkthrough.`;
  }
  return description;
}

function keywordCandidates(item, classification) {
  const set = new Set();
  const title = (item.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  for (const w of title) set.add(w);
  if (classification?.pillar) set.add(PILLARS[classification.pillar]?.label.toLowerCase() || '');
  if (item.category) set.add(item.category.toLowerCase());
  for (const t of asArray(item.tags)) set.add(String(t).toLowerCase());
  return [...set].filter(Boolean);
}

function ensureRelatedSection(body, suggestions) {
  if (suggestions.length === 0) return { changed: false, body };
  const hasRelatedHeading = /^##\s+Related\b/m.test(body);
  const links = suggestions.map((s) => `- ${anchorFor(s)}`).join('\n');
  if (hasRelatedHeading) {
    const linkedSlugs = extractInternalLinkSlugs(body);
    const newOnes = suggestions.filter((s) => !linkedSlugs.has(s.slug));
    if (newOnes.length === 0) return { changed: false, body };
    const additions = newOnes.map((s) => `- ${anchorFor(s)}`).join('\n');
    const patched = body.replace(/(##\s+Related[^\n]*\n+(?:- .*\n)*)/, (match) => `${match.trimEnd()}\n${additions}\n`);
    return { changed: true, body: patched, added: newOnes.length };
  }
  const block = `\n\n## Related\n\n${links}\n`;
  return { changed: true, body: body.trimEnd() + block, added: suggestions.length };
}

export function planOptimization(item, inventory, options = {}) {
  const changes = [];
  const next = { ...item };
  const classification = classify(item);
  const hubIndex = options.hubIndex || buildHubIndex(options.hubs || []);

  if (item.title && item.title.length > 60) {
    const shortened = shortenTitleSafely(item.title);
    if (shortened !== item.title && shortened.length <= 60) {
      changes.push({ op: 'fixTitleLength', from: item.title, to: shortened });
      next.title = shortened;
    }
  }

  const currentDesc = item.description || '';
  if (!currentDesc || currentDesc.length < 110) {
    const fixedDesc = fillDescription(currentDesc, next.title || item.title);
    if (fixedDesc !== currentDesc) {
      changes.push({ op: 'fixMetaLength', from: currentDesc, to: fixedDesc });
      next.description = fixedDesc;
    }
  }

  const currentKw = asArray(item.keywords);
  if (currentKw.length < 3) {
    const candidates = keywordCandidates(item, classification);
    const needed = 3 - currentKw.length;
    const additions = candidates
      .filter((k) => !currentKw.some((c) => String(c).toLowerCase() === k))
      .slice(0, needed);
    if (additions.length > 0) {
      changes.push({ op: 'fillMissingKeywords', added: additions });
      next.keywords = [...currentKw, ...additions];
    }
  }

  const currentTags = asArray(item.tags);
  if (currentTags.length < 2 && classification.pillar) {
    const pillarTag = PILLARS[classification.pillar].label;
    if (!currentTags.some((t) => String(t).toLowerCase() === pillarTag.toLowerCase())) {
      changes.push({ op: 'fillMissingTags', added: [pillarTag] });
      next.tags = [...currentTags, pillarTag];
    }
  }

  const linkedSlugs = extractInternalLinkSlugs(item.content || '');
  const needLinks = 3 - linkedSlugs.size;
  let bodyAfter = item.content || '';
  if (needLinks > 0) {
    const suggestions = suggestLinksFor(item, inventory.all, { limit: needLinks, minScore: 6, hubIndex });
    if (suggestions.length > 0) {
      const { changed, body, added } = ensureRelatedSection(bodyAfter, suggestions);
      if (changed) {
        changes.push({ op: 'injectInternalLinks', added, suggestions: suggestions.map((s) => ({ slug: s.slug, kind: s.kind, score: s.score })) });
        bodyAfter = body;
      }
    }
  }

  if (!item.modifiedDate) {
    const today = TODAY();
    changes.push({ op: 'addModifiedDate', to: today });
    next.modifiedDate = today;
  }

  const root = options.root || process.cwd();
  const dirMap = {
    guide: options.guidesDir || path.join(root, 'content/guides'),
    fix: options.fixesDir || path.join(root, 'content/fixes'),
    post: options.postsDir || path.join(root, 'content/posts'),
  };

  return {
    slug: item.slug,
    kind: item.kind,
    file: path.join(dirMap[item.kind] || dirMap.post, `${item.slug}.mdx`),
    changes,
    willChange: changes.length > 0,
    nextFrontmatter: {
      ...item,
      title: next.title,
      description: next.description,
      tags: next.tags,
      keywords: next.keywords,
      modifiedDate: next.modifiedDate,
    },
    nextBody: bodyAfter,
  };
}

export function applyOptimization(plan) {
  if (!plan.willChange) return { written: false };
  const filePath = plan.file;
  const actualPath = fs.existsSync(filePath) ? filePath : filePath.replace(/\.mdx$/, '.md');
  if (!fs.existsSync(actualPath)) throw new Error(`File not found: ${filePath}`);

  const raw = fs.readFileSync(actualPath, 'utf8');
  const parsed = matter(raw);
  const nextFm = { ...parsed.data };
  const changeOps = new Set(plan.changes.map((c) => c.op));
  if (changeOps.has('fixTitleLength')) nextFm.title = plan.nextFrontmatter.title;
  if (changeOps.has('fixMetaLength')) nextFm.description = plan.nextFrontmatter.description;
  if (changeOps.has('fillMissingKeywords')) nextFm.keywords = plan.nextFrontmatter.keywords;
  if (changeOps.has('fillMissingTags')) nextFm.tags = plan.nextFrontmatter.tags;
  if (changeOps.has('addModifiedDate')) nextFm.modifiedDate = plan.nextFrontmatter.modifiedDate;

  const next = matter.stringify(plan.nextBody, nextFm);
  fs.writeFileSync(actualPath, next);
  return { written: true, file: actualPath };
}

export function optimizeAll(options = {}) {
  const apply = !!options.apply;
  const filterKind = options.kind || null;
  const inventory = loadInventory(options);

  const subset = filterKind
    ? inventory[`${filterKind}s`] || inventory[filterKind] || []
    : inventory.all;

  const plans = subset.map((item) => planOptimization(item, inventory, options)).filter((p) => p.willChange);

  let applied = 0;
  const errors = [];
  if (apply) {
    for (const plan of plans) {
      try {
        const r = applyOptimization(plan);
        if (r.written) applied++;
      } catch (err) {
        errors.push({ slug: plan.slug, error: err.message });
      }
    }
  }

  const opCounts = {};
  for (const p of plans) for (const c of p.changes) opCounts[c.op] = (opCounts[c.op] || 0) + 1;

  return { scanned: subset.length, needChanges: plans.length, applied, apply, opCounts, errors, plans: options.includePlans ? plans : undefined };
}
