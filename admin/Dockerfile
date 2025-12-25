# ProxyPilot Admin Dashboard Dockerfile
# Multi-stage build for optimized production image

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Optimize for low-memory builds and CI mode
ENV NODE_OPTIONS="--max-old-space-size=512"
ENV GENERATE_SOURCEMAP=false
ENV CI=true
ENV UV_THREADPOOL_SIZE=1

# Copy frontend package files
COPY frontend/package*.json ./
RUN npm ci

# Copy frontend source and build with reduced memory usage
COPY frontend/ ./
RUN NODE_ENV=production npm run build -- --logLevel info

# Stage 2: Build backend dependencies
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy backend package files
COPY backend/package*.json ./
RUN npm install --omit=dev

# Stage 3: Production image
FROM node:20-alpine
WORKDIR /app

# Install runtime dependencies including certbot for SSL certificate management
RUN apk add --no-cache nginx curl certbot certbot-nginx

# Create non-root user
RUN addgroup -S proxypilot && adduser -S proxypilot -G proxypilot

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy backend with dependencies
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY backend/src ./backend/src
COPY backend/package.json ./backend/

# Create data directory
RUN mkdir -p /data && chown -R proxypilot:proxypilot /data

# Set environment
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/proxypilot.db

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/api/health || exit 1

# Start the application
WORKDIR /app/backend
CMD ["node", "src/index.js"]
