// Loads .env.local (then .env) into process.env. Required because the
// content-engine CLIs run via `node` directly — Next.js's automatic
// env loading only applies to `next dev`/`next build`.

import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

let loaded = false;

export function bootstrapEnv() {
  if (loaded) return;
  const root = process.cwd();
  for (const file of ['.env.local', '.env']) {
    const p = path.join(root, file);
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  }
  loaded = true;
}

bootstrapEnv();
