// Historical A6/A7 lifecycle setup only. New HTTP launches are retired and are
// tested against the unmodified real router in operational-demo-retirement.test.js.
// These older suites still need signed, active/ended records to exercise Stop,
// reconciliation and receipt handling. Seed them through the dormant internal
// service, never present this setup as current HTTP/browser acceptance.
export function historicalDemoCall(world, dispatch, enabled = true) {
  return async request => {
    const base = `/${world.p.id}/agent-runs`;
    const resume = request.path.startsWith(base + '/') && request.path.endsWith('/resume');
    if (!enabled || request.method !== 'POST' || (request.path !== base && !resume)) return dispatch(request);
    try {
      const body = resume
        ? await world.service.resume(request.user, world.p.id, request.path.slice(base.length + 1, -'/resume'.length))
        : await world.service.start(request.user, world.p.id, request.body);
      return { statusCode: 201, body, historicalFixture: true };
    } catch (error) {
      if ([401, 403, 404].includes(error.status))
        world.f.store.auditDenied(request.user, world.p.id, resume ? 'agent_run_resume' : 'agent_run_start', error.status);
      return { statusCode: error.status ?? 500, body: { error: error.message, code: error.code, ...(error.extra ?? {}) }, historicalFixture: true };
    }
  };
}
