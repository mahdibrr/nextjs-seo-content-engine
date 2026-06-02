// Refresh engine — decides which already-published pages should be rewritten
// or touched (modifiedDate bump + content tweak) to recover ranking decay.

import { classify, PILLARS } from './topic-map.js';

const DAY_MS = 86_400_000;

function parseDate(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function daysAgo(t) {
  if (t == null) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

function urgencyFromAge(ageDays, weight) {
  // Pillar weight scales how aggressively we want to refresh: a 1.0 pillar
  // gets flagged at 90 days, a 0.5 pillar at 180 days.
  const threshold = Math.round(180 - weight * 90);
  if (ageDays == null) return 'unknown';
  if (ageDays > threshold * 2) return 'critical';
  if (ageDays > threshold) return 'high';
  if (ageDays > threshold * 0.6) return 'medium';
  return 'low';
}

export function buildRefreshQueue(items, options = {}) {
  const minAge = options.minAgeDays ?? 30;
  const includeOffPillar = !!options.includeOffPillar;

  const queue = [];
  for (const item of items) {
    const cls = classify(item);
    if (!cls.pillar && !includeOffPillar) continue;

    const published = parseDate(item.date);
    const modified = parseDate(item.modifiedDate) || published;
    const ageDays = daysAgo(published);
    const modifiedAgeDays = daysAgo(modified);

    if (ageDays != null && ageDays < minAge) continue;

    const weight = (cls.pillar && PILLARS[cls.pillar]?.weight) || 0.5;
    const urgency = urgencyFromAge(modifiedAgeDays, weight);
    if (urgency === 'low' && !options.includeLow) continue;

    const reasons = [];
    if (modifiedAgeDays != null && modifiedAgeDays > 180) {
      reasons.push(`Not modified in ${modifiedAgeDays} days`);
    }
    if (/\b20(?:1[0-9]|2[0-4])\b/.test(item.title || '')) {
      reasons.push('Title references stale year');
    }
    const referencesOldNext = /\bnext\.?js\s*(?:1[0-3])\b/i.test(item.content || '') ||
      /\bnext\.?js\s*(?:1[0-3])\b/i.test(item.title || '');
    if (referencesOldNext) reasons.push('References pre-Next 14 versions');

    let action = 'review';
    if (urgency === 'critical') action = 'rewrite';
    else if (urgency === 'high') action = 'expand';
    else if (urgency === 'medium') action = 'touch';

    queue.push({
      slug: item.slug,
      title: item.title,
      pillar: cls.pillar,
      pillarWeight: weight,
      intent: cls.intent,
      published: item.date,
      modified: item.modifiedDate || item.date,
      ageDays,
      modifiedAgeDays,
      urgency,
      action,
      reasons,
    });
  }

  const rank = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };
  return queue.sort((a, b) => {
    if (rank[b.urgency] !== rank[a.urgency]) return rank[b.urgency] - rank[a.urgency];
    if (b.pillarWeight !== a.pillarWeight) return b.pillarWeight - a.pillarWeight;
    return (b.modifiedAgeDays || 0) - (a.modifiedAgeDays || 0);
  });
}

export function summarizeQueue(queue) {
  const summary = { total: queue.length, byUrgency: {}, byAction: {}, byPillar: {} };
  for (const entry of queue) {
    summary.byUrgency[entry.urgency] = (summary.byUrgency[entry.urgency] || 0) + 1;
    summary.byAction[entry.action] = (summary.byAction[entry.action] || 0) + 1;
    const key = entry.pillar || '__unclassified';
    summary.byPillar[key] = (summary.byPillar[key] || 0) + 1;
  }
  return summary;
}
