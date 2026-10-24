// PLACEHOLDER (app-side foundation branch) — SUPERSEDED AT MERGE.
//
// The real foundation-stack-logic.js (the guest's Compose stack: compose.yaml,
// pg_hba.conf / pg_ident.conf, bring-up) is written on the host-side
// foundation branch. This branch needs only buildFoundationComposeYaml({
// portable: true }) — scaffold.js passes the portable stack into
// scaffold-foundation.js as foundation/compose.yaml — so this file stands in
// for it with that one export. At merge, KEEP THE HOST-SIDE FILE and drop this
// one; scaffold.js already imports from this path, so nothing else changes.
//
// The content below is a reasonable portable stack so tests and the generated
// repository are coherent until then. PURE.

import { STACK } from './foundation-contract.js';

export function buildFoundationComposeYaml({ portable = true } = {}) {
  const { postgres: pg, storage: s3, embeddings: emb } = STACK;
  return `# PLACEHOLDER portable foundation stack — replaced by the host-side generator.
# ${portable ? 'Portable copy: runs the same stack outside ProxyPilot.' : 'Guest copy.'}
# All three services are always defined; turning a feature off stops its
# container and never removes its volume.
name: ${STACK.composeProject}
services:
  ${pg.service}:
    image: ${pg.image}
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${pg.database}
      POSTGRES_HOST_AUTH_METHOD: peer
    # No TCP port is published: the app connects over the Unix socket.
    volumes:
      - ${pg.volume}:/var/lib/postgresql
      - ${pg.socketDir}:/var/run/postgresql
  ${s3.service}:
    image: ${s3.image}
    restart: unless-stopped
    command: ["server", "-dir=/data", "-s3", "-s3.port=${s3.port}"]
    ports:
      - "${s3.listen}:${s3.port}:${s3.port}"
    volumes:
      - ${s3.volume}:/data
  ${emb.service}:
    image: ${emb.image}
    restart: unless-stopped
    command: ["--model-id", "${emb.model}", "--auto-truncate"]
    ports:
      - "${emb.listen}:${emb.port}:80"
    volumes:
      - ${emb.volume}:/data
volumes:
  ${pg.volume}: {}
  ${s3.volume}: {}
  ${emb.volume}: {}
`;
}
