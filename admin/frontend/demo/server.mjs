import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const buildRoot = path.resolve(here, '../dist-demo');
const sampleFile = path.resolve(here, 'files/sample-metrics.csv');
const host = process.env.DEMO_HOST || '127.0.0.1';
const port = Number(process.env.DEMO_PORT || 4179);
const publicOrigin = process.env.DEMO_PUBLIC_ORIGIN || `http://${host}:${port}`;
const secureCookie = new URL(publicOrigin).protocol === 'https:';
const allowedOrigins = new Set([
  publicOrigin,
  ...(process.env.DEMO_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  ...(!process.env.DEMO_PUBLIC_ORIGIN ? ['http://127.0.0.1:4178'] : []),
]);
const email = process.env.DEMO_EMAIL || 'demo@fractionate.ai';
const password = process.env.DEMO_PASSWORD || 'welcome-demo';
const showDemoCredentials = !process.env.DEMO_EMAIL && !process.env.DEMO_PASSWORD;
const sessions = new Map();
const failures = new Map();
const maxBody = 16 * 1024;
const sessionMs = 8 * 60 * 60 * 1000;

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DEMO_PORT');
if (!existsSync(path.join(buildRoot, 'index.html'))) {
  throw new Error('Demo build missing. Run npm run demo:build first.');
}

const json = (res, status, body, headers = {}) => {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
};

const equal = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

const cookies = (req) => Object.fromEntries(
  String(req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key),
);

const activeSession = (req) => {
  const token = cookies(req).fractionate_demo_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
};

const cookie = (token, maxAge) =>
  `fractionate_demo_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

const readJson = async (req) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const staticTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const serveStatic = (pathname, method, res) => {
  const candidate = path.resolve(buildRoot, `.${pathname}`);
  const found = candidate.startsWith(`${buildRoot}${path.sep}`) && existsSync(candidate) && statSync(candidate).isFile();
  if (!found && (pathname.startsWith('/assets/') || path.extname(pathname))) {
    return json(res, 404, { error: 'Not found.' });
  }
  const file = found ? candidate : path.join(buildRoot, 'index.html');
  const info = statSync(file);
  res.writeHead(200, {
    'Content-Type': staticTypes[path.extname(file)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  });
  if (method === 'HEAD') return res.end();
  return createReadStream(file).pipe(res);
};

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const url = new URL(req.url || '/', publicOrigin);
  const pathname = url.pathname;

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Request origin was refused.' });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    return json(res, 200, { demoCredentials: showDemoCredentials, email: showDemoCredentials ? email : null });
  }
  if (pathname === '/api/session' && req.method === 'GET') {
    const session = activeSession(req);
    return json(res, 200, { authenticated: !!session, email: session?.email || null });
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const attempt = failures.get(ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 8) {
      return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }
    let body;
    try { body = await readJson(req); }
    catch { return json(res, 400, { error: 'Enter a valid email and password.' }); }
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string'
      || !equal(body.email.trim().toLowerCase(), email.toLowerCase()) || !equal(body.password, password)) {
      const next = attempt?.until > Date.now() ? attempt.count + 1 : 1;
      failures.set(ip, { count: next, until: Date.now() + 5 * 60 * 1000 });
      return json(res, 401, { error: 'Email or password did not match.' });
    }
    failures.delete(ip);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { email, expiresAt: Date.now() + sessionMs });
    return json(res, 200, { authenticated: true, email }, { 'Set-Cookie': cookie(token, sessionMs / 1000) });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = cookies(req).fractionate_demo_session;
    if (token) sessions.delete(token);
    return json(res, 200, { authenticated: false }, { 'Set-Cookie': cookie('', 0) });
  }
  if (pathname === '/api/files' && req.method === 'GET') {
    if (!activeSession(req)) return json(res, 401, { error: 'Sign in to view files.' });
    return json(res, 200, { files: [{
      id: 'sample-metrics',
      name: 'sample-metrics.csv',
      description: 'A small project activity report',
      type: 'CSV',
      size: statSync(sampleFile).size,
      updatedAt: '2026-09-25',
      downloadUrl: '/api/files/sample-metrics/download',
    }] });
  }
  if (pathname === '/api/files/sample-metrics/download' && req.method === 'GET') {
    if (!activeSession(req)) return json(res, 401, { error: 'Sign in to download files.' });
    const info = statSync(sampleFile);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sample-metrics.csv"',
      'Content-Length': info.size,
      'Cache-Control': 'private, no-store',
    });
    return createReadStream(sampleFile).pipe(res);
  }
  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  return serveStatic(pathname, req.method, res);
});

server.listen(port, host, () => {
  process.stdout.write(`Fractionate demo listening at http://${host}:${port}\n`);
});
