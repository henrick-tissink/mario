# syntax=docker/dockerfile:1

# Pinned to the patch. A silent minor bump of the runtime under a native addon
# is not something to discover from a restart loop.
FROM node:22.23.1-slim

# There is deliberately NO build stage and no compiler here. better-sqlite3 13.x
# ships Node-API prebuilds for linux-x64/arm64 and both musl variants inside its
# npm tarball and declares no install script, so `npm ci` needs no python, make
# or g++. If you ever see a compile during install, prebuild resolution broke —
# find out why rather than installing a toolchain.
#
# sqlite3 is the one apt package that earns its place: it is how backups are
# taken (VACUUM INTO) and how a restore is verified (integrity_check).
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY ops ./ops

# Fixed uid so a host bind mount can be chowned to match. A NAMED volume
# inherits this ownership on first mount; a BIND mount does not — chown the host
# directory to 10001:10001 first or the process gets EACCES on its first write.
RUN useradd --system --uid 10001 --shell /usr/sbin/nologin --home-dir /app mario \
 && mkdir -p /data \
 && chmod +x ops/*.sh \
 && chown -R mario:mario /data /app

USER mario

# Hardcoded, not defaulted. src/db.ts falls back to the RELATIVE path "mario.db",
# which would put the database on the container's writable layer and destroy it
# on the next deploy while every health check stayed green.
ENV MARIO_DB=/data/mario.db \
    PORT=8787

EXPOSE 8787
VOLUME ["/data"]

# Liveness only, and deliberately shallow — see src/health.ts for why fold
# freshness must never reach a restart probe. No curl in slim; node has fetch.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, node as PID 1. `npm start` or a shell form would put npm or sh at
# PID 1, which does not forward SIGTERM — the handler in src/index.ts would
# never run and every deploy would SIGKILL the process mid-write.
CMD ["node", "--import", "tsx", "src/index.ts"]
