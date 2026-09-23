// G4: bounded, self-hosted Core contract. No arbitrary config, image or command.
import { z } from 'zod';
import { createHash } from 'node:crypto';
export const POMERIUM_IMAGE = 'pomerium/pomerium:v0.33.3';
export const POMERIUM_VERSION = '0.33.3';
export const POMERIUM_APP = 'pp-platform-pomerium';
export const POMERIUM_ROOT = '/var/lib/proxypilot/pomerium';
export const POMERIUM_PORT = 18081;
export const POMERIUM_GRPC_PORT = 18082;
export const POMERIUM_METRICS_PORT = 18083;
export const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export const pomeriumError = message => Object.assign(new Error(message), { status: 409, pomeriumSafe: true });
export const pomeriumJobSchema = z.object({ revision: z.number().int().positive() }).strict();
export const pomeriumConfigSchema = z.object({
  expectedPlanRevision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(),
  connectionId: z.string().regex(/^kc-[a-f0-9]{12}$/),
  clientId: z.string().regex(/^[A-Za-z0-9._-]{3,100}$/),
  clientSecret: z.string().min(16).max(4096).optional(),
  externalContainer: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/).optional(),
  reviewed: z.literal(true),
}).strict();
export const pomeriumRouteSchema = z.object({
  expectedRevision: z.number().int().positive(), routeId: z.string().min(1).max(100),
  action: z.enum(['protect', 'remove']),
  subjects: z.array(z.string().min(1).max(255)).max(20),
}).strict();
export const pomeriumApplySchema = z.object({ expectedRevision: z.number().int().positive(), reviewed: z.literal(true) }).strict();
export const pomeriumRouteApplySchema = pomeriumRouteSchema.extend({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
export const IDENTITY_HEADERS = ['X-Pomerium-*', 'X-Forwarded-User', 'X-Forwarded-Email', 'X-Forwarded-Groups', 'X-Auth-Request-*', 'Remote-User'];
export function renderPomeriumConfig(config, intents, secrets) {
  return {
    services: 'all', address: `127.0.0.1:${POMERIUM_PORT}`, insecure_server: true,
    grpc_address: `127.0.0.1:${POMERIUM_GRPC_PORT}`, grpc_insecure: true,
    // v0.33.3 otherwise defaults internal URLs to 5443, not grpc_address.
    authorize_service_url: `http://127.0.0.1:${POMERIUM_GRPC_PORT}`,
    databroker_service_url: `http://127.0.0.1:${POMERIUM_GRPC_PORT}`,
    metrics_address: `127.0.0.1:${POMERIUM_METRICS_PORT}`, health_check_addr: '127.0.0.1:18084', http_redirect_addr: '',
    authenticate_service_url: config.origin, idp_provider: 'oidc', idp_provider_url: config.issuer,
    idp_client_id: config.clientId, idp_client_secret: secrets.client,
    idp_scopes: ['openid', 'profile', 'email'], cookie_name: '_pp_pomerium', cookie_expire: '1h',
    cookie_secret: secrets.cookie, shared_secret: secrets.shared, signing_key: secrets.signing,
    autocert: false, databroker_storage_type: 'memory',
    routes: intents.filter(i => i.action !== 'remove').map(i => ({
      name: `proxypilot-${i.routeId}`, from: `https://${i.domain}`, to: i.upstream,
      preserve_host_header: true, pass_identity_headers: true,
      policy: [{ allow: { or: i.subjects.map(subject => ({ 'claim/sub': subject })) } }],
    })),
  };
}
