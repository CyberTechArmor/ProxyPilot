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
import { validateBrandingPatch, publicBranding } from '../lib/branding-logic.js';

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
