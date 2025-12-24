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
import { authenticateToken } from './middleware/auth.js';

// Load environment variables
config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Security middleware - relaxed CSP for production
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP to avoid blocking frontend
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [`https://${process.env.DOMAIN}`, `http://${process.env.DOMAIN}`]
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
});
app.use('/api/auth/login', authLimiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
