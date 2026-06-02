// Google Search Console synchronization.
//
// Env vars:
//   GSC_CLIENT_ID       — OAuth client id
//   GSC_CLIENT_SECRET   — OAuth client secret
//   GSC_REFRESH_TOKEN   — OAuth user refresh token
//   GSC_QUOTA_PROJECT   — Google Cloud project for OAuth API quota
//   GSC_CLIENT_EMAIL   — service-account email (alternative to OAuth)
//   GSC_PRIVATE_KEY    — PEM key (alternative to OAuth)
//   GSC_SITE_URL       — e.g. 'https://www.yoursite.com/'
//
// Data is persisted to data/gsc.json.

import fs from 'node:fs';
import path from 'node:path';
import { getAccessToken } from './jwt-sign.js';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEARCH_ANALYTICS_URL = (site) =>
  `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;

export function getGscConfig() {
  const clientId = process.env.GSC_CLIENT_ID || '';
  const clientSecret = process.env.GSC_CLIENT_SECRET || '';
  const refreshToken = process.env.GSC_REFRESH_TOKEN || '';
  const quotaProject = process.env.GSC_QUOTA_PROJECT || '';
  const clientEmail = process.env.GSC_CLIENT_EMAIL || '';
  const privateKey = process.env.GSC_PRIVATE_KEY || '';
  const siteUrl = process.env.GSC_SITE_URL || '';
  const oauthEnabled = Boolean(clientId && clientSecret && refreshToken && siteUrl);
  const serviceAccountEnabled = Boolean(clientEmail && privateKey && siteUrl);
  const mode = oauthEnabled ? 'oauth' : serviceAccountEnabled ? 'service-account' : 'disabled';
  const enabled = mode !== 'disabled';
  return { enabled, mode, clientId, clientSecret, refreshToken, quotaProject, clientEmail, privateKey, siteUrl };
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function queryGsc(token, siteUrl, body, quotaProject) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (quotaProject) headers['X-Goog-User-Project'] = quotaProject;
  const res = await fetch(SEARCH_ANALYTICS_URL(siteUrl), { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GSC searchAnalytics ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.rows || [];
}

export async function refreshOAuthAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth refresh failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Google OAuth refresh did not return an access_token');
  return data.access_token;
}

async function getGscAccessToken(config) {
  if (config.mode === 'oauth') {
    return refreshOAuthAccessToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
    });
  }
  return getAccessToken({ clientEmail: config.clientEmail, privateKey: config.privateKey, scope: SCOPE });
}

export async function syncGsc(options = {}) {
  const config = getGscConfig();
  if (!config.enabled) return { skipped: true, reason: 'GSC credentials not configured' };

  const days = options.days || 90;
  const rowLimit = options.rowLimit || 5000;
  const startDate = options.startDate || isoDaysAgo(days);
  const endDate = options.endDate || isoDaysAgo(2);

  const token = await getGscAccessToken(config);
  const baseBody = { startDate, endDate, rowLimit };

  const [pageRows, queryRows, pageQueryRows] = await Promise.all([
    queryGsc(token, config.siteUrl, { ...baseBody, dimensions: ['page'] }, config.quotaProject),
    queryGsc(token, config.siteUrl, { ...baseBody, dimensions: ['query'] }, config.quotaProject),
    queryGsc(token, config.siteUrl, { ...baseBody, dimensions: ['page', 'query'], rowLimit: Math.min(rowLimit, 25000) }, config.quotaProject),
  ]);

  const pages = {};
  for (const row of pageRows) {
    pages[row.keys[0]] = { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position };
  }

  const queries = {};
  for (const row of queryRows) {
    queries[row.keys[0]] = { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position, pages: [] };
  }

  const pageQueries = {};
  for (const row of pageQueryRows) {
    const [page, query] = row.keys;
    if (!pageQueries[page]) pageQueries[page] = [];
    pageQueries[page].push({ query, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position });
    if (queries[query] && !queries[query].pages.includes(page)) queries[query].pages.push(page);
  }

  const out = { fetchedAt: new Date().toISOString(), range: { startDate, endDate }, site: config.siteUrl, pages, queries, pageQueries };
  const dest = options.destination || path.join(process.cwd(), 'data', 'gsc.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));

  return { skipped: false, dest, summary: {
    pages: Object.keys(pages).length,
    queries: Object.keys(queries).length,
    pageQueryPairs: pageQueryRows.length,
    range: out.range,
  }};
}

export function loadGscCache(file) {
  const dest = file || path.join(process.cwd(), 'data', 'gsc.json');
  if (!fs.existsSync(dest)) return null;
  try { return JSON.parse(fs.readFileSync(dest, 'utf8')); } catch { return null; }
}

export function lowCtrPages(cache, options = {}) {
  if (!cache || !cache.pages) return [];
  const minImpressions = options.minImpressions ?? 100;
  const maxCtr = options.maxCtr ?? 0.02;
  return Object.entries(cache.pages)
    .filter(([, m]) => m.impressions >= minImpressions && m.ctr <= maxCtr)
    .map(([url, m]) => ({ url, ...m }))
    .sort((a, b) => b.impressions - a.impressions);
}

export function keywordGaps(cache, options = {}) {
  if (!cache || !cache.queries) return [];
  const minImpressions = options.minImpressions ?? 50;
  const maxClicks = options.maxClicks ?? 1;
  return Object.entries(cache.queries)
    .filter(([, m]) => m.impressions >= minImpressions && m.clicks <= maxClicks)
    .map(([query, m]) => ({ query, ...m }))
    .sort((a, b) => b.impressions - a.impressions);
}
