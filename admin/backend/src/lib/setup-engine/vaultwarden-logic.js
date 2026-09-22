import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
// Official 1.37.3 source: eb212e23fad88e6136723f43e5b73543fa7026d3.
export const VAULTWARDEN_VERSION = '1.37.3';
export const VAULTWARDEN_IMAGE = 'vaultwarden/server:1.37.3';
export const VAULTWARDEN_APP = 'pp-platform-vaultwarden';
export const VAULTWARDEN_ROOT = '/var/lib/proxypilot/vaultwarden';
export const VAULTWARDEN_PORT = 18380;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fail = message => Object.assign(new Error(message), { status: 409, vaultwardenSafe: true });
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,99}$/);
const secret = z.string().min(16).max(8192).regex(/^[^\r\n\0]+$/);
export const configSchema = z.object({
  expectedPlanRevision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(),
  connectionId: name, clientId: name, clientSecret: secret.optional(), adminToken: secret.optional(),
  accessRole: name, matchExistingEmail: z.boolean(),
  allowedIps: z.array(z.string().refine(v => isIP(v) === 4)).max(16).default([]), reviewed: z.literal(true),
}).strict();
export const jobSchema = z.object({ revision: z.number().int().positive() }).strict();
export const applySchema = jobSchema.extend({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
// These are explicitly operator observations, never an automated login/unlock claim.
// No free text, credentials, item contents, recovery codes or account names enter this endpoint.
export const ceremonySchema = applySchema.extend({ configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  browserSso: z.literal(true), vaultUnlock: z.literal(true), harmlessItem: z.literal(true),
  deniedUser: z.literal(true), existingLogin: z.literal(true), accountPreserved: z.literal(true), disposable: z.literal(true),
}).strict();
export const namesFor = r => { const server = `pp-g7-${r.credential_ref.slice(-12)}`; return { server, network: `${server}-net` }; };
export const callbackFor = r => `${r.config.origin}/identity/connect/oidc-signin`;
export const flowAlias = r => `pp-vaultwarden-${r.config.clientId}`;
export const expectedSettings = r => ({ domain: r.config.origin, sso_enabled: true, sso_only: false,
  sso_authority: r.config.issuer, sso_client_id: r.config.clientId, sso_callback_path: callbackFor(r),
  sso_pkce: true, sso_scopes: 'openid profile email offline_access', sso_signups_match_email: r.config.matchExistingEmail,
  sso_allow_unknown_email_verification: false, sso_auth_only_not_session: false, sso_debug_tokens: false,
  // An empty Some("") regex accepts any extra audience in 1.37.3. Require
  // an explicit exact match, also distinguishable in effective admin readback.
  sso_authorize_extra_params: '', sso_audience_trusted: `^${r.config.clientId.replaceAll('.', '\\.')}$`,
});
