# ProxyPilot Admin Dashboard Dockerfile
# Expects frontend to be pre-built (frontend/dist directory)

# Stage 1: Build backend dependencies
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend

# Install build dependencies for better-sqlite3.
#
# `apk add` regularly hits transient DNS / mirror errors on the
# Alpine CDN — they're recoverable but break `docker build` hard
# because the apk command exits non-zero and the layer fails. Wrap
# in a retry loop with backoff so a 30-second CDN hiccup doesn't
# blow up the whole update path. Five attempts with exponential
# backoff (2s, 4s, 8s, 16s, 32s) covers anything short of a real
# outage; if it's still failing after that we fall through and the
# original error is what the operator sees.
RUN for i in 1 2 3 4 5; do \
        apk add --no-cache python3 make g++ && break || { \
            echo "apk add attempt $i/5 failed, sleeping $((i*i*2))s"; \
            sleep $((i*i*2)); \
        }; \
    done && command -v g++ >/dev/null

# Copy backend package files
COPY backend/package*.json ./
RUN npm install --omit=dev

# Stage 2: Production image
FROM node:20-alpine
WORKDIR /app

# Install runtime dependencies (same retry logic as the builder
# stage — curl is a single small package but the CDN doesn't care
# what you're asking for, only whether it can resolve).
RUN for i in 1 2 3 4 5; do \
        apk add --no-cache curl && break || { \
            echo "apk add attempt $i/5 failed, sleeping $((i*i*2))s"; \
            sleep $((i*i*2)); \
        }; \
    done && command -v curl >/dev/null

# Create non-root user
RUN addgroup -S proxypilot && adduser -S proxypilot -G proxypilot

# Copy pre-built frontend (built on host before docker build)
COPY frontend/dist ./frontend/dist

# Verify frontend was copied correctly
RUN test -f ./frontend/dist/index.html || (echo "ERROR: frontend/dist/index.html not found in Docker build context" && exit 1)
RUN ls -la ./frontend/dist/

# Copy backend with dependencies
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY backend/src ./backend/src
COPY backend/package.json ./backend/

# Create data directory
RUN mkdir -p /data && chown -R proxypilot:proxypilot /data

# Set environment
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/db/proxypilot.db

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/api/health || exit 1

# Start the application
WORKDIR /app/backend
CMD ["node", "src/index.js"]
