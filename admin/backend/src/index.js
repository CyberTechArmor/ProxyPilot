import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { initDatabase } from './db.js';
import { authRouter } from './routes/auth.js';
import { servicesRouter } from './routes/services.js';
import { userRouter } from './routes/user.js';
import { lxcRouter } from './routes/lxc.js';
import { authenticateToken } from './middleware/auth.js';

// Load environment variables - check multiple paths for .env
// The .env file may be in the install root (/opt/proxypilot/.env) or
// in the backend dir (admin/backend/.env) depending on deployment method
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPaths = [
  join(__dirname, '../../../.env'),  // Install root: /opt/proxypilot/.env (from src/)
  join(__dirname, '../../.env'),     // Project root when running from repo
  join(__dirname, '../.env'),        // Backend dir: admin/backend/.env
];

let envLoaded = false;
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    console.log('Loaded .env from:', envPath);
    envLoaded = true;
    break;
  }
}
if (!envLoaded) {
  // Fallback: let dotenv try default paths
  config();
}

const app = express();
const PORT = process.env.PORT || 3001;

// Determine frontend path - check multiple locations
const possibleFrontendPaths = [
  join(__dirname, '../../frontend/dist'),
  join(__dirname, '../../../frontend/dist'),
  '/app/frontend/dist',
];
const FRONTEND_PATH = possibleFrontendPaths.find(p => existsSync(p)) || possibleFrontendPaths[0];
console.log('Frontend path:', FRONTEND_PATH, '- exists:', existsSync(FRONTEND_PATH));

// Security middleware. CSP previously disabled wholesale; replaced with
// a real policy that closes the obvious XSS vectors:
//   * default-src 'self'  — no remote anything by default
//   * script-src 'self'   — no inline JS, no remote JS
//   * style-src 'self' 'unsafe-inline' — Tailwind + React runtime styles
//     need inline style attributes; this is the standard concession
//   * img-src 'self' data: — TOTP setup renders QR codes as data: URIs
//   * connect-src 'self' — fetch only to same-origin (the backend)
//   * frame-ancestors 'none' — prevents clickjacking via iframe embed
//   * object-src 'none' — no Flash/PDF plugin embeds
//   * base-uri 'self' — locks <base> to defeat one XSS pivot
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 60 * 60 * 24 * 365, includeSubDomains: true, preload: false }
    : false,
}));

// CORS configuration. In production, only allow the configured DOMAIN
// over HTTPS — the http:// alias was a development crutch and accepting
// it in production lets a downgrade attack on the user's network slip
// the same-origin assumption.
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [`https://${process.env.DOMAIN}`]
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

// Rate limiting - increased for dashboard usage
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 300, // 300 requests per minute (5 per second)
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter rate limit for credential-bearing auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
});
app.use('/api/auth/login', authLimiter);

// First-time setup endpoints — even tighter cap. These are only used once
// per install but are unauthenticated, so brute-forcing them must be
// expensive. Both the password-set and the TOTP-confirm steps are
// covered.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many setup attempts, please try again later.' },
});
app.use('/api/auth/initial-setup', setupLimiter);
app.use('/api/auth/complete-totp-setup', setupLimiter);

// setup-status is polled by the frontend on every page load to decide
// whether to show the setup wizard, so it needs a higher ceiling than
// the credential endpoints. Still rate-limited to prevent enumeration
// at scale.
const setupStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/auth/setup-status', setupStatusLimiter);

// Body parsing. Default limit is tight (1mb) to shrink the unauth and
// admin-action attack surface. Routes that legitimately accept large
// payloads — base64 file upload/import on the services router — get a
// dedicated express.json() with the 55mb cap mounted in front of the
// services router below. LXC routes (lxc.js) use multer for uploads,
// which has its own 2GB limit and does not flow through express.json.
const DEFAULT_BODY_LIMIT = '1mb';
const UPLOAD_BODY_LIMIT = '55mb';
app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));

// Larger body limit only on the routes that need it. Order matters:
// these handlers run before the servicesRouter in the chain because
// express middleware is matched in registration order and we install
// these BEFORE the router below.
const uploadJson = express.json({ limit: UPLOAD_BODY_LIMIT });
const uploadPaths = [
  '/api/services/:id/upload/*',
  '/api/services/:id/files/*',
  '/api/services/:id/import-files',
  '/api/services/import',
  '/api/services/terminal/upload-file',
  '/api/services/docker/volumes/import',
  '/api/services/discover/import',
];
for (const p of uploadPaths) {
  app.use(p, uploadJson);
}

// Initialize database
initDatabase();

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), frontendPath: FRONTEND_PATH });
});

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/services', authenticateToken, servicesRouter);
app.use('/api/user', authenticateToken, userRouter);
app.use('/api/lxc', authenticateToken, lxcRouter);

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  console.log('Serving static files from:', FRONTEND_PATH);
  app.use(express.static(FRONTEND_PATH));

  // Handle SPA routing - serve index.html for all non-API routes
  app.get('*', (req, res) => {
    const indexPath = join(FRONTEND_PATH, 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      console.error('index.html not found at:', indexPath);
      res.status(404).send('Frontend not found. Please rebuild the application.');
    }
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ProxyPilot backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Frontend path: ${FRONTEND_PATH}`);
});
