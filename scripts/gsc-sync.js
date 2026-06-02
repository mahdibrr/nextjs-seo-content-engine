#!/usr/bin/env node
// gsc-sync.js — pulls Search Console data to data/gsc.json.
//
// Requires env vars: GSC_SITE_URL + (GSC_CLIENT_EMAIL+GSC_PRIVATE_KEY OR OAuth vars).

import '../src/lib/content-engine/bootstrap-env.js';
import { syncGsc, getGscConfig } from '../src/lib/content-engine/gsc-sync.js';

const config = getGscConfig();
if (!config.enabled) {
  console.log('GSC credentials not configured — set GSC_SITE_URL + GSC_CLIENT_EMAIL + GSC_PRIVATE_KEY (or OAuth vars) in .env');
  process.exit(0);
}

console.log(`Syncing GSC data for ${config.siteUrl} (mode: ${config.mode})...`);
const result = await syncGsc({});
if (result.skipped) {
  console.log('Skipped:', result.reason);
} else {
  console.log(`Done. Pages: ${result.summary.pages}, Queries: ${result.summary.queries}, Range: ${result.summary.range.startDate} → ${result.summary.range.endDate}`);
  console.log(`Written to: ${result.dest}`);
}
