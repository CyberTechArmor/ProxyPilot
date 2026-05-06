# ProxyPilot Admin Dashboard Dockerfile
# Build context is the install root (admin/ + proxypilot/ both reachable).
# Frontend is pre-built before docker build (admin/frontend/dist).

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
COPY admin/backend/package*.json ./

# `npm install` regularly hits transient DNS / mirror flakes too —
# `node-pty` ships glibc-only prebuilds, so on alpine (musl) it has
# to be rebuilt from source via node-gyp, which fetches Node headers
# from unofficial-builds.nodejs.org. A momentary `getaddrinfo
# EAI_AGAIN` against that host fails the whole `update.sh` rebuild
# (which always uses --no-cache). Wrap in the same five-attempt
# exponential-backoff loop the apk add steps use.
RUN for i in 1 2 3 4 5; do \
        npm install --omit=dev && break || { \
            echo "npm install attempt $i/5 failed, sleeping $((i*i*2))s"; \
            sleep $((i*i*2)); \
        }; \
    done && test -d node_modules

# Stage 2: Production image
FROM node:20-alpine
WORKDIR /app

# Runtime dependencies. Same retry pattern as the builder. Now also
# carries the CVE engine's Python deps so paste / sync / validate /
# mark-seen / dismiss work without depending on the host. Engine
# commands that actually mutate the host (poll, run-one) still pivot
# through nsenter -t 1 — see runEngine() in routes/cves.js.
#
#   - python3 + py3-ruamel.yaml: engine runtime
#   - util-linux: provides nsenter for the host pivot
#   - git: source-git sync clones into /var/lib/proxypilot/cve-inbox-source
#   - curl: healthcheck
RUN for i in 1 2 3 4 5; do \
        apk add --no-cache curl python3 py3-ruamel.yaml util-linux git \
            && break || { \
            echo "apk add attempt $i/5 failed, sleeping $((i*i*2))s"; \
            sleep $((i*i*2)); \
        }; \
    done && command -v curl >/dev/null \
         && command -v python3 >/dev/null \
         && command -v nsenter >/dev/null \
         && command -v git >/dev/null

# Create non-root user
RUN addgroup -S proxypilot && adduser -S proxypilot -G proxypilot

# Copy pre-built frontend (built on host before docker build)
COPY admin/frontend/dist ./frontend/dist

# Verify frontend was copied correctly
RUN test -f ./frontend/dist/index.html || (echo "ERROR: admin/frontend/dist/index.html not found in Docker build context" && exit 1)
RUN ls -la ./frontend/dist/

# Copy backend with dependencies
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY admin/backend/src ./backend/src
COPY admin/backend/package.json ./backend/

# Copy the CVE engine Python package. Lives at /app/proxypilot so
# `python3 -m proxypilot.engine ...` resolves with PYTHONPATH=/app.
# Tests live alongside; they're harmless at runtime.
COPY proxypilot ./proxypilot

# Create data directory
RUN mkdir -p /data && chown -R proxypilot:proxypilot /data

# Set environment
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/db/proxypilot.db
# In-container PYTHONPATH so the engine resolves without a system
# pip install. The host pivot uses PROXYPILOT_INSTALL_DIR (set by
# install.sh) for the same purpose on the host side.
ENV PYTHONPATH=/app

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/api/health || exit 1

# Start the application
WORKDIR /app/backend
CMD ["node", "src/index.js"]
