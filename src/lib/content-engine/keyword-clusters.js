// Keyword clusters — derives terminology coverage per pillar so we can
// detect topical gaps without relying on an external SEO API.

import { PILLARS, classify, asArray } from './topic-map.js';

// Canonical long-tail terms per pillar. Customize for your site's niche.
// These are tested against post bodies, so keep them specific.
export const CANONICAL_TERMS = {
  'nextjs-supabase': [
    'app router', 'server actions', 'middleware', 'streaming',
    'partial prerendering', 'edge runtime', 'route handler',
    'parallel routes', 'intercepting routes', 'mdx',
    'data fetching pattern', 'server component',
  ],
  'supabase-auth': [
    'rls policy', 'magic link', 'oauth google', 'oauth github',
    'session middleware', 'auth callback', 'refresh token',
    'email confirmation', 'service role key', 'auth helper',
  ],
  'supabase-debugging': [
    'silent failure', 'infinite recursion', 'slow query',
    'connection pool', 'realtime gotcha', 'cold start',
    'rate limit', 'free tier limit',
  ],
  'nextjs-performance': [
    'turbopack', 'lcp', 'cls', 'inp', 'web vitals',
    'lighthouse', 'bundle analyzer', 'image optimization',
    'font optimization', 'isr', 'on demand revalidation',
  ],
  'stripe-payments': [
    'webhook signature', 'idempotency key', 'subscription lifecycle',
    'checkout session', 'customer portal', 'metered billing',
    'tax calculation', 'invoice preview',
  ],
  'n8n-automation': [
    'workflow trigger', 'crm lead', 'self-hosted', 'ollama',
    'zapier migration', 'silent failure', 'webhook node', 'http request',
  ],
  'firebase-comparison': [
    'firestore vs postgres', 'firebase auth vs supabase auth',
    'firestore pricing', 'firebase hosting', 'firestore security rules',
  ],
  'typescript': [
    'type generation', 'discriminated union', 'zod', 'generic',
    'type guard', 'satisfies', 'utility type',
  ],
  'ai-development': [
    'pgvector', 'rag pipeline', 'embedding', 'openai', 'anthropic',
    'tool use', 'ollama', 'vector index',
  ],
  'saas-business': [
    'pricing strategy', 'mrr', 'churn', 'free tier', 'usage based',
    'enterprise tier', 'self-serve',
  ],
};

export function buildClusters(items) {
  const clusters = {};
  for (const key of Object.keys(PILLARS)) {
    clusters[key] = {
      pillar: key,
      label: PILLARS[key].label,
      terms: Object.fromEntries(
        (CANONICAL_TERMS[key] || []).map((t) => [t, { count: 0, slugs: [] }])
      ),
      items: [],
      missing: [],
      coverage: 0,
    };
  }

  for (const item of items) {
    const { pillar } = classify(item);
    if (!pillar || !clusters[pillar]) continue;
    clusters[pillar].items.push(item);

    const haystack = [
      item.title || '',
      item.description || '',
      asArray(item.tags).join(' '),
      asArray(item.keywords).join(' '),
      (item.content || ''),
    ].join(' ').toLowerCase();

    for (const term of Object.keys(clusters[pillar].terms)) {
      if (haystack.includes(term)) {
        clusters[pillar].terms[term].count++;
        clusters[pillar].terms[term].slugs.push(item.slug);
      }
    }
  }

  for (const key of Object.keys(clusters)) {
    const cluster = clusters[key];
    const termKeys = Object.keys(cluster.terms);
    if (termKeys.length === 0) {
      cluster.coverage = 1;
      continue;
    }
    const covered = termKeys.filter((t) => cluster.terms[t].count > 0).length;
    cluster.coverage = Number((covered / termKeys.length).toFixed(3));
    cluster.missing = termKeys.filter((t) => cluster.terms[t].count === 0);
  }

  return clusters;
}

export function rankClustersByGap(clusters) {
  return Object.values(clusters)
    .filter((c) => c.terms && Object.keys(c.terms).length > 0)
    .sort((a, b) => b.missing.length - a.missing.length);
}
