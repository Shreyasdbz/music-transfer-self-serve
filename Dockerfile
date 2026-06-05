# Multi-stage build: install + build the Vite client, then run one Node process
# that serves the built client (web/dist) AND the API. better-sqlite3 is a
# native module, so both stages use the same Debian base for ABI compatibility.

FROM node:20-bookworm-slim AS build
WORKDIR /app
# Toolchain for building better-sqlite3 from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Install deps first (layer-cached on lockfile changes).
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
RUN npm ci
# Build: tokens.css + server typecheck + web (vite build → web/dist).
COPY . .
RUN npm run build:all

FROM node:20-bookworm-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
# Installed deps (incl. the compiled better-sqlite3) + workspace symlinks.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/server /app/server
COPY --from=build /app/packages /app/packages
COPY --from=build /app/web/dist /app/web/dist
# Runtime state dirs (mount volumes here). 0700 per §12.5.
RUN mkdir -p /app/server/data /app/server/secrets \
  && chmod 700 /app/server/data /app/server/secrets
EXPOSE 8888
# The server reads config from env (BIND_HOST, PORT, PUBLIC_ORIGIN,
# ALLOWED_ORIGINS, ALLOWED_HOSTS, INSTANCE_ACCESS_TOKEN, SESSION_SECRET, plus the
# Spotify/Apple keys). Behind a reverse proxy set BIND_HOST=0.0.0.0.
CMD ["npx", "tsx", "src/server.ts"]
