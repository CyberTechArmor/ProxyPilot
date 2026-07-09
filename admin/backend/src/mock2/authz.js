// Mock2 project authorization middleware (Phase M2, ADR-007).
//
// requireMock2Role(minRole) resolves whether the request user may act on the
// project named by :id at (at least) the given project role. Admins and
// superadmins bypass membership; a bypass into a project the admin does not
// belong to is stamped acting_as_admin (surfaced on chats and change records
// in later phases). The DECISION is the pure resolveMock2Access (project-logic
// .js) so the ladder is unit-testable without Express or the DB; this wrapper
// only does the lookups and the 403/404 wiring.
//
// It also loads the project onto req.mock2Project so the handler doesn't
// re-query, and req.mock2Access = { allowed, actingAsAdmin, role }.
//
// Terminology (risk R7): nothing here is named "agent".

import { getProject, getMembership, isUserSuperadmin } from './projects.js';
import { resolveMock2Access } from './project-logic.js';

export function requireMock2Role(minRole = 'viewer') {
  return function mock2RoleGuard(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const project = getProject(Number(req.params.id));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Only pay for the superadmin lookup when the user isn't already an admin
    // (admins bypass either way).
    const isSuperadmin = req.user.role === 'admin' ? true : isUserSuperadmin(req.user.id);
    const membership = getMembership(project.id, req.user.id) || null;
    const access = resolveMock2Access({ user: req.user, membership, requiredRole: minRole, isSuperadmin });

    if (!access.allowed) {
      // 404 (not 403) for a non-member with no access at all, so the module
      // does not confirm a project's existence to someone with no business
      // knowing it exists; 403 when they're a member lacking the level.
      if (access.reason === 'not a project member') {
        return res.status(404).json({ error: 'Project not found' });
      }
      return res.status(403).json({ error: `This action requires the ${minRole} role on this project` });
    }

    req.mock2Project = project;
    req.mock2Access = access;
    next();
  };
}
