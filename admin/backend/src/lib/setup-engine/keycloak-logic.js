// G2's deliberately bounded adapter contract. No caller-selected commands,
// images, local paths, credentials, clients or authentication settings.
import { z } from 'zod';
import { validateOperatorEgressInput, isIpv4 } from '../../mock2/egress-logic.js';
export const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.7.4';
export const KEYCLOAK_DB_IMAGE = 'postgres:17.9-bookworm';
export const KEYCLOAK_APP = 'pp-platform-keycloak';
export const KEYCLOAK_PORT = 18080;
export const KEYCLOAK_ROOT = '/var/lib/proxypilot/keycloak';
export const realmSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const keycloakTargetSchema = z.object({
  mode: z.enum(['install', 'connect']),
  url: z.string().max(300).refine(value => {
    try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password && validateOperatorEgressInput({ host: u.hostname, port: Number(u.port || 443), protocol: 'https' }).ok; } catch { return false; }
  }, 'Keycloak requires an HTTPS origin without a path.'),
  realm: realmSchema,
}).strict().superRefine((t, ctx) => {
  let u; try { u = new URL(t.url); } catch { return; }
  if (t.mode === 'install' && (u.port || isIpv4(u.hostname) || t.realm === 'master')) ctx.addIssue({ code: 'custom', message: 'Managed Keycloak requires a DNS hostname on HTTPS port 443 and a dedicated realm other than master.' });
});
export const keycloakJobSchema = z.object({ installationId: z.string().regex(/^kc-[a-f0-9]{12}$/), revision: z.number().int().positive() }).strict();
export const keycloakApplySchema = z.object({ expectedRevision: z.number().int().positive(), reviewed: z.literal(true), retry: z.boolean().optional() }).strict();
export const issuerFor = t => `${t.url}/realms/${t.realm}`;
export const resourceNames = id => ({ network: `pp-${id}-net`, volume: `pp-${id}-data`, database: `pp-${id}-db`, server: `pp-${id}-server` });
export function keycloakReview(target) {
  return { target, issuer: issuerFor(target), ownership: target.mode === 'install' ? 'managed' : 'external',
    changes: target.mode === 'install' ? [
      `Run ${KEYCLOAK_IMAGE} and ${KEYCLOAK_DB_IMAGE} as independent Docker services with persistent database storage.`,
      `Add one Caddy HTTPS route for ${new URL(target.url).hostname} to host loopback port ${KEYCLOAK_PORT}. Public ports and certificates remain with Caddy.`,
      `Create the ${target.realm} realm and protected bootstrap/database files. Reuse them on retry.`,
      'Verify database/service readiness, public discovery, exact issuer and public signing keys.',
    ] : ['Read realm discovery and signing keys at this HTTPS origin (including its explicitly approved private-network address, if configured).', 'Record the verified external connection; administrative permission is not checked. No realm, user, client or credential is changed.'],
    access: 'ProxyPilot login, users, sessions and application routes stay unchanged. ProxyPilot SSO not activated.' };
}
