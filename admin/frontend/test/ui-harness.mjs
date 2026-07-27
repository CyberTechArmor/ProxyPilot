// Serve the REAL built ProxyPilot SPA against a stubbed API, so a browser can
// drive the actual component tree. Reasoning about Radix/Tailwind layout has
// been wrong twice; this renders it.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = '/home/user/ProxyPilot/admin/frontend/dist';
const PORT = Number(process.env.PORT || 4599);

// One project, in whichever stage the caller asks for via ?stage=.
const stage = process.env.STAGE || 'design';   // 'design' | 'build'
const project = {
  id: 7,
  name: 'Harness Project',
  slug: 'harness',
  lifecycle: 'active',
  container_name: 'pp-7',
  url: 'https://harness.example.com',
  current_mockup_id: stage === 'build' ? 3 : null,
  design_preset: null,
  archived_at: null,
  stage: { design_approved: stage === 'build' },
  design_approved_at: stage === 'build' ? '2026-07-01T00:00:00Z' : null,
  members: [],
  role: 'editor',
  can_edit: true,
};

const J = (body) => ({ body: JSON.stringify(body), type: 'application/json' });

function api(pathname) {
  const USER = {
    id: 1, username: 'op', email: 'op@example.com', role: 'admin', is_admin: 1,
    permissions: ['*'], features: ['*'],
  };
  if (/\/auth\/(verify|me)$/.test(pathname) || pathname.endsWith('/me')) return J({ user: USER, csrf: 'x' });
  if (pathname.endsWith('/auth/setup-status')) return J({ needsSetup: false, setup_required: false });
  if (/\/mock2\/projects\/\d+\/assets$/.test(pathname)) {
    return J({ assets: [], tags: [], summary: { total: 0, images: 0, content: 0 }, limits: { maxBytes: 8388608 } });
  }
  if (/\/mock2\/projects\/\d+\/chat/.test(pathname)) {
    return J({ messages: [], job: null, audit_job: null, stage: project.stage, open_question_ids: [], current_mockup_id: project.current_mockup_id });
  }
  if (/\/mock2\/projects\/\d+\/provision/.test(pathname)) return J({ progress: null, job: null });
  if (/\/mock2\/projects\/\d+\/lock/.test(pathname)) return J({ lock: { held: false } });
  if (/\/mock2\/projects\/\d+\/harness/.test(pathname)) return J({ harness: {} });
  if (/\/mock2\/projects\/\d+\/remote/.test(pathname)) return J({ remote: null });
  if (/\/mock2\/projects\/\d+\/cycles/.test(pathname)) return J({ cycles: [] });
  if (/\/mock2\/projects\/\d+\/files/.test(pathname)) return J({ entries: [] });
  if (/\/mock2\/projects\/\d+$/.test(pathname)) return J({ project });
  if (/\/mock2\/status/.test(pathname)) return J({ enabled: true, slots: {} });
  if (/\/users/.test(pathname)) return J({ users: [] });
  return J({});                        // anything else: harmless empty object
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const r = api(url.pathname);
    res.writeHead(200, { 'Content-Type': r.type, 'Set-Cookie': 'pp_csrf=x; Path=/' });
    return res.end(r.body);
  }
  const file = path.join(DIST, url.pathname);
  if (url.pathname !== '/' && existsSync(file) && !file.endsWith('/')) {
    const ext = path.extname(file);
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    return res.end(readFileSync(file));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  return res.end(readFileSync(path.join(DIST, 'index.html')));
}).listen(PORT, () => console.log(`harness on ${PORT} (stage=${stage})`));
