// Platform branding — the admin dashboard's own name, logo, and favicon,
// operator-editable (Profile → Platform branding card). Values live in
// app_settings (branding_name / branding_logo / branding_favicon) as small
// data URIs, validated by the pure lib/branding-logic.js.
//
// Auth model: the GET is PUBLIC — the login page renders the platform's name
// and logo before any session exists, and nothing here is secret (it is the
// branding on the front door). The PUT is admin-only over the normal cookie
// session, with full CSRF protection like every other mutation.

import { Router } from 'express';
import { logAudit, getSetting, setSetting } from '../db.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { createHash } from 'crypto';
import { validateBrandingPatch, publicBranding, decodeDataUri } from '../lib/branding-logic.js';

export const brandingRouter = Router();

function currentBranding() {
  return publicBranding({
    name: getSetting('branding_name'),
    logo: getSetting('branding_logo'),
    favicon: getSetting('branding_favicon'),
  });
}

brandingRouter.get('/', (_req, res) => {
  res.json(currentBranding());
});

// The custom mark as a fetchable file — the favicon, or the logo when only a
// logo was set. This is what the branded manifest and the apple-touch-icon
// link point at, because neither can carry inline data. Public like the GET:
// it is the icon on the front door. 404 under stock branding, so the shipped
// PNG set stays the only icon then.
brandingRouter.get('/icon', (req, res) => {
  const mark = decodeDataUri(getSetting('branding_favicon')) || decodeDataUri(getSetting('branding_logo'));
  if (!mark) return res.status(404).json({ error: 'No custom branding icon is set' });
  // Revalidate every time (a changed logo must show up on the next install),
  // but let an unchanged one be a cheap 304.
  const etag = `"${createHash('sha1').update(mark.buffer).digest('hex')}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('Content-Type', mark.mime);
  res.send(mark.buffer);
});

brandingRouter.put('/', authenticateToken, requireAdmin, (req, res) => {
  const check = validateBrandingPatch(req.body || {});
  if (!check.ok) return res.status(400).json({ error: check.error });
  for (const [key, value] of Object.entries(check.patch)) {
    setSetting(`branding_${key}`, value);
  }
  // Fields only — a base64 logo in the audit log would be noise at best.
  logAudit(req.user.id, 'BRANDING_UPDATED', 'app_settings', null, { fields: Object.keys(check.patch) }, req.ip);
  res.json(currentBranding());
});
