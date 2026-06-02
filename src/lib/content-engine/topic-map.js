// Topic map — the canonical taxonomy the site is trying to rank for.
//
// Customize PILLARS for your own site's topic taxonomy.
// Entities are loose — substring-matched against title, tags, keywords, and
// the first ~600 chars of body.

export const PILLARS = {
  'nextjs-supabase': {
    label: 'Next.js + Supabase',
    weight: 1.0,
    entities: [
      'next.js', 'nextjs', 'next 14', 'next 15', 'next 16', 'app router',
      'server components', 'server actions', 'supabase', 'postgres',
      'pgvector', 'realtime', 'vercel', 'edge function',
    ],
    intents: ['guide', 'comparison', 'troubleshooting', 'migration', 'implementation', 'checklist'],
    hubSlug: 'nextjs-supabase',
  },
  'supabase-auth': {
    label: 'Supabase Auth & RLS',
    weight: 0.95,
    entities: [
      'supabase auth', 'rls', 'row level security', 'auth session',
      'middleware', 'oauth', 'magic link', 'email confirmation', 'jwt',
      'session persistence', 'auth redirect',
    ],
    intents: ['troubleshooting', 'implementation', 'checklist'],
    hubSlug: 'supabase-debugging',
  },
  'supabase-debugging': {
    label: 'Supabase Debugging',
    weight: 0.9,
    entities: [
      'rls infinite recursion', 'silent failure', 'slow query', 'realtime gotcha',
      'connection pooling', 'session persistence', 'auth error',
      'supabase error', 'postgres function', 'trigger',
    ],
    intents: ['troubleshooting'],
    hubSlug: 'supabase-debugging',
  },
  'nextjs-performance': {
    label: 'Next.js Performance',
    weight: 0.85,
    entities: [
      'caching', 'revalidate', 'isr', 'ssr', 'partial prerendering',
      'turbopack', 'web vitals', 'lcp', 'cls', 'inp', 'lighthouse',
      'bundle size', 'hydration',
    ],
    intents: ['guide', 'troubleshooting', 'implementation'],
    hubSlug: 'nextjs-supabase',
  },
  'stripe-payments': {
    label: 'Stripe & Payments',
    weight: 0.75,
    entities: [
      'stripe', 'webhook', 'subscription', 'pricing', 'checkout',
      'idempotency', 'invoice', 'payment intent',
    ],
    intents: ['implementation', 'troubleshooting', 'guide'],
    hubSlug: 'nextjs-supabase',
  },
  'n8n-automation': {
    label: 'n8n Automation',
    weight: 0.7,
    entities: [
      'n8n', 'zapier', 'make.com', 'workflow', 'crm', 'lead capture',
      'ollama', 'self-hosted',
    ],
    intents: ['implementation', 'migration', 'troubleshooting'],
    hubSlug: 'n8n-automation',
  },
  'firebase-comparison': {
    label: 'Firebase vs Supabase',
    weight: 0.7,
    entities: [
      'firebase', 'firestore', 'firebase auth', 'firebase hosting',
      'switching from firebase',
    ],
    intents: ['comparison', 'migration'],
    hubSlug: 'nextjs-supabase',
  },
  'typescript': {
    label: 'TypeScript for Production',
    weight: 0.6,
    entities: [
      'typescript', 'type safety', 'type generation', 'generic',
      'discriminated union', 'zod',
    ],
    intents: ['guide', 'migration'],
    hubSlug: 'nextjs-supabase',
  },
  'ai-development': {
    label: 'AI for Developers',
    weight: 0.55,
    entities: [
      'openai', 'anthropic', 'claude', 'rag', 'vector search',
      'pgvector', 'embeddings', 'ollama', 'llm',
    ],
    intents: ['implementation', 'guide'],
    hubSlug: 'nextjs-supabase',
  },
  'saas-business': {
    label: 'SaaS Business & Pricing',
    weight: 0.5,
    entities: [
      'saas', 'pricing', 'mrr', 'churn', 'indie hacker', 'solo founder',
      'bootstrapping', 'subscription model',
    ],
    intents: ['guide', 'comparison'],
    hubSlug: 'nextjs-supabase',
  },
};

export const INTENT_PATTERNS = {
  troubleshooting: [
    /\b(fix|error|not working|stuck|failed|debug(?:ging)?|broken|issue|problem|gotcha)\b/i,
    /\b(why is|why does|why doesn't|how to fix)\b/i,
  ],
  comparison: [
    /\bvs\b/i, /\bversus\b/i, /\bor\b.+\?$/i,
    /\b(comparison|compared to|which is better|alternative to)\b/i,
  ],
  migration: [
    /\b(migrat|migrating|switch|moving|move from|port|porting)\b.+\bto\b/i,
    /\b(from .+ to .+)\b/i,
  ],
  implementation: [
    /\b(build|building|how I built|step by step|complete (?:build|guide))\b/i,
    /\b(integrate|integration|set up|setup|implement|implementing)\b/i,
  ],
  checklist: [
    /\b(checklist|cheat ?sheet|reference|one[- ]page|launch list)\b/i,
  ],
  guide: [
    /\b(guide|tutorial|introduction|beginner|complete)\b/i,
  ],
  incident: [
    /\b(postmortem|incident|outage|what happened|lessons learned)\b/i,
  ],
};

const INTENT_PRIORITY = [
  'troubleshooting', 'incident', 'comparison', 'migration',
  'implementation', 'checklist', 'guide',
];

export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === 'string') return v.split(/[,;]\s*/).filter(Boolean);
  return [String(v)];
}

export function classify(item) {
  const haystack = [
    item.title || '',
    item.description || '',
    asArray(item.tags).join(' '),
    asArray(item.keywords).join(' '),
    item.category || '',
    (item.content || '').slice(0, 600),
  ].join(' ').toLowerCase();

  let bestPillar = null;
  let bestPillarScore = 0;
  for (const [key, pillar] of Object.entries(PILLARS)) {
    let matches = 0;
    for (const entity of pillar.entities) {
      if (haystack.includes(entity)) matches++;
    }
    const score = matches * pillar.weight;
    if (score > bestPillarScore) {
      bestPillarScore = score;
      bestPillar = key;
    }
  }

  let intent = null;
  for (const candidate of INTENT_PRIORITY) {
    const patterns = INTENT_PATTERNS[candidate] || [];
    if (patterns.some((rx) => rx.test(item.title || ''))) {
      intent = candidate;
      break;
    }
  }

  return {
    pillar: bestPillar,
    intent: intent || 'guide',
    score: bestPillarScore,
  };
}

export function groupByPillar(items) {
  const out = {};
  for (const key of Object.keys(PILLARS)) out[key] = [];
  out.__unclassified = [];

  for (const item of items) {
    const { pillar } = classify(item);
    if (pillar && out[pillar]) {
      out[pillar].push(item);
    } else {
      out.__unclassified.push(item);
    }
  }
  return out;
}

export function getPillar(key) {
  return PILLARS[key] || null;
}

export function listPillars() {
  return Object.entries(PILLARS).map(([key, pillar]) => ({ key, ...pillar }));
}
