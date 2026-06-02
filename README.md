# nextjs-seo-content-engine

Autonomous SEO content engine extracted from a production Next.js blog. Drop it into any MDX-based blog to get pillar taxonomy, keyword gap detection, content scoring, internal link suggestions, Google Search Console sync, and AI-powered article generation.

## What it does

```
npm run seo:score           # score every post/guide 0-100
npm run seo:optimize        # dry-run safe frontmatter patches
npm run seo:optimize:apply  # apply patches in place
npm run gsc:sync            # pull Search Console data to data/gsc.json
npm run content:opportunities  # find content gaps from GSC + pillar map
```

## Pipeline overview

```
GSC data (data/gsc.json)
        │
        ▼
content:opportunities ──► content-opportunities.json
        │
        ▼
 topic-map + keyword-clusters  ──► pillar/intent classification
        │
        ▼
 content-scoring ──► seo-report.json  (0-100 per article)
        │
        ▼
 seo-optimizer ──► patch titles, descriptions, tags, internal links
        │
        ▼
 content-generator ──► AI drafts → review-pending/ → publish
```

## Modules

| Module | Responsibility |
|--------|---------------|
| `topic-map.js` | Pillar taxonomy + intent classifier |
| `keyword-clusters.js` | Canonical-term coverage per pillar |
| `internal-linking.js` | Scored link suggestions + link graph |
| `content-scoring.js` | Per-item 0..100 SEO score (8 dimensions) |
| `refresh-engine.js` | Urgency-ranked rewrite queue |
| `gsc-sync.js` | Google Search Console → JSON cache |
| `jwt-sign.js` | Zero-dep RS256 JWT signer (node:crypto only) |
| `ai-client.js` | OpenAI-compatible HTTP client |
| `anti-spam-autopilot.js` | Entropy scoring + structural diversity checks |
| `ai-reviewer.js` | Second AI pass on generated articles |
| `seo-optimizer.js` | Safe deterministic patches to existing MDX |
| `content-generator.js` | AI-powered MDX article generation |
| `bootstrap-env.js` | .env loader for CLI scripts |

## Setup

```bash
npm install

# Copy and configure:
cp .env.example .env
# Edit .env with your SITE_URL, AI provider, GSC credentials
```

## Content scoring

Each article is scored 0–100 across 8 dimensions:

| Dimension | Max | What it checks |
|-----------|-----|----------------|
| Title | 12 | Length 30-60 chars, action verb |
| Description | 12 | Length 110-160 chars |
| Content length | 14 | ≥800w post / ≥2000w guide |
| Headings | 10 | ≥3 H2, has H3, ≥5 total |
| Internal links | 14 | ≥3 valid slug links |
| Outbound links | 6 | ≥1 external authority link |
| Schema | 10 | Article + FAQ + HowTo |
| Topical alignment | 12 | Pillar match weight |

## Customizing for your niche

Edit `src/lib/content-engine/topic-map.js` to define your own pillars. Each pillar needs:
- `entities` — substring patterns that signal a post belongs to this pillar
- `intents` — which content types you want to cover
- `weight` — relative importance (0.5–1.0)

Edit `src/lib/content-engine/keyword-clusters.js` to add your canonical long-tail terms.

## AI generation

The generator uses any OpenAI-compatible API (Ollama, OpenAI, DeepSeek, Groq). Set `AI_PROVIDER` and the relevant env vars. Every generated article goes through:

1. Hard validation gate (word count, internal links, pillar match)
2. Anti-spam autopilot (entropy score, structural similarity, cliché detection)
3. AI second-pass review (code completeness, truncation, accuracy)

Generated articles land in `content/review-pending/` for manual approval before going live.

## Production use

This engine runs daily on [iloveblogs.blog](https://iloveblogs.blog) via GitHub Actions. The blog grew from 0 to 143 referring domains in 5 months using this pipeline.

## License

MIT — see [LICENSE](LICENSE).
