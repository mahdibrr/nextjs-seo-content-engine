#!/usr/bin/env node
// seo-optimize.js — applies safe deterministic SEO patches to existing MDX files.
//
// Usage:
//   node scripts/seo-optimize.js             # dry run (no writes)
//   node scripts/seo-optimize.js --apply     # write changes to disk

import '../src/lib/content-engine/bootstrap-env.js';
import { optimizeAll } from '../src/lib/content-engine/seo-optimizer.js';

function parseArgs(argv) {
  const args = { apply: false, kind: null };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--kind=')) args.kind = a.split('=')[1];
  }
  return args;
}

const args = parseArgs(process.argv);
console.log(`Mode: ${args.apply ? 'APPLY (writes to disk)' : 'DRY RUN'}`);

const r = optimizeAll({ apply: args.apply, kind: args.kind });
console.log(`Scanned: ${r.scanned}  Need changes: ${r.needChanges}  Applied: ${r.applied}`);
for (const [op, n] of Object.entries(r.opCounts)) console.log(`  ${op.padEnd(22)} ${n}`);
if (r.errors.length > 0) {
  console.error(`Errors: ${r.errors.length}`);
  for (const e of r.errors) console.error(`  ${e.slug}: ${e.error}`);
}
