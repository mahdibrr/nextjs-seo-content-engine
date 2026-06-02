// ai-reviewer.js — second AI pass on a generated article.
//
// Uses the AI client with a critic prompt instead of the generation prompt.
// Returns { ok, score, issues, summary, skipped }

import { chatComplete, getAiConfig } from './ai-client.js';

// Customize SITE_NICHE to match your blog's topics.
const SITE_NAME = process.env.SITE_NAME || 'your blog';
const SITE_NICHE = process.env.SITE_NICHE || 'Next.js, Supabase, and full-stack web development';

const SYSTEM_PROMPT = `You are a strict technical editor for ${SITE_NAME}, a professional blog about ${SITE_NICHE}.

Your job: review a generated article and decide if it is ready to publish RIGHT NOW, with zero edits.

Check these five things carefully:

1. CODE_COMPLETENESS — Every JS/TS code block must have its import statements. If the code uses a named import, the import line must be present in the same block. Flag any block that uses a function without importing it.

2. TRUNCATION — The article must end with a complete sentence. A section that ends mid-sentence is a hard reject.

3. TECHNICAL_ACCURACY — The advice must be correct for the versions mentioned. Flag any advice that contradicts framework docs or is clearly wrong.

4. CODE_SAFETY — No hardcoded credentials. Patterns like \`password === "secret"\` or real API keys in code examples must be replaced with placeholders like \`process.env.SECRET\`.

5. COMPLETENESS — Every section referenced must exist. If the article says "see the Verify section below" but there is no Verify section, flag it.

Respond with ONLY valid JSON. No text before or after. No markdown fences.

{
  "publishable": true,
  "score": 85,
  "issues": [],
  "summary": "One sentence verdict."
}

Rules:
- "publishable": true ONLY when all five checks pass with no blockers
- score < 70 must set publishable: false
- issues must be specific: quote the exact line or section that is wrong
- If you cannot find any problems, say so in summary and set publishable: true`;

export async function reviewArticleWithAi(article, options = {}) {
  const aiConfig = getAiConfig();
  if (!aiConfig.enabled) {
    return { ok: true, score: null, issues: [], summary: 'AI review skipped — client not configured', skipped: true };
  }

  const content = `TITLE: ${article.title || '(no title)'}\n\n${article.content || ''}`;

  let raw;
  try {
    raw = await chatComplete(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Review this article and return JSON only:\n\n${content}` },
      ],
      { temperature: 0.1, maxTokens: 600 }
    );
  } catch (err) {
    return { ok: true, score: null, issues: [], summary: `AI review network error: ${err.message}`, skipped: true };
  }

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in response');
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { ok: true, score: null, issues: [], summary: 'AI review: could not parse model response', skipped: true };
  }

  const score = typeof parsed.score === 'number' ? Math.round(parsed.score) : null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(Boolean) : [];
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const publishable = parsed.publishable === true && (score === null || score >= 70);

  return { ok: publishable, score, issues, summary, skipped: false };
}
