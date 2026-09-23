export const SERVICES = [
  { id: 'keycloak', name: 'Keycloak', description: 'Identity provider for shared sign-in. Managed clients and independent recovery are verified before login activation.' },
  { id: 'pomerium', name: 'Pomerium', description: 'Access gateway: Caddy → Pomerium → application. Requires a verified identity provider; Full Platform connects its dedicated client automatically.' },
  { id: 'infisical', name: 'Infisical with Agent Proxy', description: 'Application secrets and a separate Agent Proxy for brokered credentials. Save choices first, then review the bounded guide.' },
  { id: 'openbao', name: 'OpenBao', description: 'Secrets and policy service. Choosing recovery custody and keeping the one-time recovery kit remain explicit human actions.' },
  { id: 'vaultwarden', name: 'Vaultwarden', description: 'Password vault. Keycloak sign-in and separate vault-unlock checks are guided by the available adapter.' },
];
