// Internal linking engine — produces ranked link suggestions for any item,
// and a per-item "incoming link" inventory so the orphan detector can find
// pages that nothing links to.
//
// The score combines:
//   - hub co-membership   (+15)  — strongest topical signal
//   - shared pillar       (+8)
//   - shared category     (+6)
//   - shared tags         (+2 per shared tag, capped at 8)
//   - shared keywords     (+1 per shared keyword, capped at 4)
//   - title token Jaccard (+0..6)
//   - already linked      (-100)  — never suggest links we already have

import { classify, asArray } from './topic-map.js';

const TITLE_STOPWORDS = new Set([
  'a','an','and','the','to','of','in','on','for','with','from','by','at',
  'is','are','be','your','my','our','how','why','what','when','where',
  'this','that','these','those','it','as','vs','or','but','if','do','does',
  '2024','2025','2026','guide','complete','quick','easy','tips','best','top',
]);

function titleTokens(title) {
  if (!title) return new Set();
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t))
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Build a hub co-membership index from an optional hubs configuration.
// Pass your hubs array here, or leave empty if you don't use hubs.
// Hub format: [{ sections: [{ posts: ['slug1',...], guides: ['slug1',...] }] }]
export function buildHubIndex(hubs = []) {
  const index = new Map();
  for (const hub of hubs) {
    for (const section of (hub.sections || [])) {
      const all = [...(section.posts || []), ...(section.guides || [])];
      for (const slug of all) {
        if (!index.has(slug)) index.set(slug, new Set());
        for (const other of all) {
          if (other !== slug) index.get(slug).add(other);
        }
      }
    }
  }
  return index;
}

export function extractInternalLinkSlugs(content) {
  if (!content) return new Set();
  const slugs = new Set();
  const rx = /\/(?:post|guides?|fix)\/([a-z0-9][a-z0-9-]*[a-z0-9])/gi;
  let m;
  while ((m = rx.exec(content)) !== null) slugs.add(m[1].toLowerCase());
  return slugs;
}

export function buildLinkGraph(items) {
  const incoming = new Map();
  const outgoing = new Map();
  const classifications = new Map();

  for (const item of items) {
    incoming.set(item.slug, []);
    outgoing.set(item.slug, new Set());
    classifications.set(item.slug, classify(item));
  }

  for (const item of items) {
    const linked = extractInternalLinkSlugs(item.content);
    outgoing.set(item.slug, linked);
    for (const target of linked) {
      if (!incoming.has(target)) continue;
      incoming.get(target).push({ from: item.slug, kind: item.kind || 'post' });
    }
  }

  return { incoming, outgoing, classifications };
}

export function suggestLinksFor(source, candidates, options = {}) {
  const { limit = 8, minScore = 4 } = options;
  const hubIndex = options.hubIndex || buildHubIndex(options.hubs || []);
  const siblings = hubIndex.get(source.slug) || new Set();
  const linked = extractInternalLinkSlugs(source.content);

  const sourceClass = classify(source);
  const sourceTokens = titleTokens(source.title);
  const sourceTags = new Set(asArray(source.tags).map((t) => String(t).toLowerCase()));
  const sourceKeywords = new Set(asArray(source.keywords).map((k) => String(k).toLowerCase()));

  const out = [];
  for (const cand of candidates) {
    if (cand.slug === source.slug) continue;
    if (linked.has(cand.slug)) continue;

    let score = 0;
    if (siblings.has(cand.slug)) score += 15;

    const candClass = classify(cand);
    if (sourceClass.pillar && candClass.pillar === sourceClass.pillar) score += 8;

    if (cand.category && source.category &&
        cand.category.toLowerCase() === source.category.toLowerCase()) {
      score += 6;
    }

    const sharedTags = asArray(cand.tags).filter((t) => sourceTags.has(String(t).toLowerCase()));
    score += Math.min(sharedTags.length * 2, 8);

    const sharedKw = asArray(cand.keywords).filter((k) => sourceKeywords.has(String(k).toLowerCase()));
    score += Math.min(sharedKw.length, 4);

    score += jaccard(sourceTokens, titleTokens(cand.title)) * 6;

    if (score >= minScore) {
      out.push({
        slug: cand.slug,
        title: cand.title,
        kind: cand.kind || 'post',
        score: Number(score.toFixed(2)),
        signals: {
          hubSibling: siblings.has(cand.slug),
          pillar: candClass.pillar,
          sharedCategory: cand.category && source.category &&
            cand.category.toLowerCase() === source.category.toLowerCase(),
          sharedTags,
          sharedKeywords: sharedKw,
        },
      });
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function anchorFor(suggestion) {
  const path = suggestion.kind === 'guide' ? `/guides/${suggestion.slug}`
    : suggestion.kind === 'fix' ? `/fix/${suggestion.slug}`
      : `/post/${suggestion.slug}`;
  return `[${suggestion.title}](${path})`;
}
