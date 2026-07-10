// Mock2 project terminal authorizer (ADR-007 + ADR-001).
//
// A shell terminal into a project's Incus container (m2-<id>) rides the shared
// core streaming-terminal route (routes/terminal-ws.js). That core file must NOT
// statically import anything mock2 — importing mock2/db.js pulls in native
// better-sqlite3 and opens mock2.db, which ADR-001 forbids on a disabled or
// production-pinned host. So the core exposes a registration hook
// (setMock2TerminalAuthorizer) and THIS module — only loaded when the module is
// enabled (src/index.js dynamic import) — registers the authorizer.
//
// mock2TerminalAuthorize({ user, projectId }) is the whole gate: it does the DB
// lookups, resolves the access ladder at the 'editor' role (a shell is a mutate
// capability — read-only viewers do not get one), and returns the WS-upgrade
// verdict + the resolved container name for the PTY. The pure decision is
// mock2TerminalDecision (project-logic.js), unit-tested stub-first (risk R9).
//
// Terminology (risk R7): nothing here is named "agent".

import { getProject, getMembership, isUserSuperadmin } from './projects.js';
import { resolveMock2Access, mock2TerminalDecision } from './project-logic.js';
import { containerNameForProject } from './provision.js';

// Returns { ok, status, reason, containerName, actingAsAdmin }. Never throws —
// any lookup failure degrades to a 404 (don't confirm a project's existence to
// someone who shouldn't know it exists).
export function mock2TerminalAuthorize({ user, projectId } = {}) {
  if (!user) return { ok: false, status: 401, reason: 'Authentication required' };
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 404, reason: 'Project not found' };

  let project = null;
  let access = null;
  try {
    project = getProject(id) || null;
    if (project) {
      const isSuperadmin = user.role === 'admin' ? true : isUserSuperadmin(user.id);
      const membership = getMembership(id, user.id) || null;
      access = resolveMock2Access({ user, membership, requiredRole: 'editor', isSuperadmin });
    }
  } catch {
    return { ok: false, status: 404, reason: 'Project not found' };
  }

  const decision = mock2TerminalDecision({ project, access });
  if (!decision.ok) return decision;

  return {
    ok: true,
    status: 200,
    reason: decision.reason,
    actingAsAdmin: decision.actingAsAdmin,
    containerName: project.container_name || containerNameForProject(id),
  };
}
