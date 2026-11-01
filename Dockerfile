# syntax=docker/dockerfile:1
# The JJ Bot app image: the API, which serves the built web app and embeds the
# worker. `docker compose up` builds it (see compose.yaml). The internal
# packages export TypeScript source, so the API runs on Node with tsx.
ARG NODE_IMAGE=node:24-bookworm-slim

# Workspace manifests only, so dependency layers are cached across source edits.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sandbox/package.json packages/sandbox/

# Behind a TLS-intercepting proxy, pass its CA bundle as the optional build
# secret `build_ca` (`docker build --secret id=build_ca,src=ca.pem`); it is
# trusted by npm during the build and never stored in a layer.

# Full install and the web bundle.
FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm \
  --mount=type=secret,id=build_ca,required=false \
  if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
  && npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @jj/web

# Production dependencies of the API and the worker only (tsx included).
FROM manifests AS deps
RUN --mount=type=cache,target=/root/.npm \
  --mount=type=secret,id=build_ca,required=false \
  if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
  && npm ci --omit=dev --no-audit --no-fund \
    --workspace @jj/api --workspace @jj/worker --include-workspace-root=false

FROM ${NODE_IMAGE} AS runtime
# The app runs node directly, so the package managers go. The app user owns
# nothing in /app: the code is read-only to it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
  && groupadd --system --gid 10001 jj \
  && useradd --system --uid 10001 --gid jj --home-dir /nonexistent \
    --no-create-home --shell /usr/sbin/nologin jj
WORKDIR /app
COPY --from=deps /src/ ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/jj-entrypoint
COPY --chmod=755 docker/healthcheck.sh /usr/local/bin/jj-healthcheck

ENV NODE_ENV=production \
  API_HOST=0.0.0.0 \
  API_PORT=3001 \
  JJ_SANDBOX_DRIVERS=docker
EXPOSE 3001

# The entrypoint starts as root only to join the Docker socket's group, then
# drops to jj (uid 10001) for the app.
ENTRYPOINT ["jj-entrypoint"]
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD ["jj-healthcheck"]

LABEL org.opencontainers.image.title="jj-bot" \
  org.opencontainers.image.description="JJ Bot: API, web app and embedded worker" \
  org.opencontainers.image.source="https://github.com/LemonPhase/jj-bot"
