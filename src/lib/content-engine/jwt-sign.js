// Zero-dependency RS256 JWT signer for Google service accounts.
//
// Google's OAuth 2.0 service account flow requires a signed JWT that we
// exchange for an access token. We do it with node:crypto so we don't pull
// in `googleapis` (3 MB) for one round trip.
//
// Reference: https://developers.google.com/identity/protocols/oauth2/service-account#jwt-auth

import crypto from 'node:crypto';

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function signGoogleJwt({ clientEmail, privateKey, scope }) {
  if (!clientEmail || !privateKey) {
    throw new Error('signGoogleJwt: clientEmail and privateKey are required');
  }
  const pem = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const sig = signer.sign(pem);
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export async function exchangeJwtForToken(jwt) {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
}

let cachedToken = null;
let cachedExpiry = 0;

export async function getAccessToken({ clientEmail, privateKey, scope }) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExpiry - 60) return cachedToken;
  const jwt = signGoogleJwt({ clientEmail, privateKey, scope });
  const tokenResponse = await exchangeJwtForToken(jwt);
  cachedToken = tokenResponse.access_token;
  cachedExpiry = now + (tokenResponse.expires_in || 3600);
  return cachedToken;
}

export function resetTokenCache() {
  cachedToken = null;
  cachedExpiry = 0;
}
