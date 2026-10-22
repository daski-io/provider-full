# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund \
 && npm audit --omit=dev --audit-level=moderate

COPY tsconfig.json tsconfig.test.json ./
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
COPY src ./src
# The build embeds its source digest; pass the commit it was built from with
# --build-arg SOURCE_COMMIT=<sha> to embed that too.
ARG SOURCE_COMMIT=""
RUN SOURCE_COMMIT="${SOURCE_COMMIT}" npm run build

RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/daski-io/provider-full" \
      org.opencontainers.image.description="Daski provider-full runtime"

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

# The runtime executes prebuilt JavaScript only. Removing npm/npx eliminates
# an unnecessary package-management attack surface and its transitive tools.
RUN rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
EXPOSE 4000
USER node
CMD ["node", "dist/bootstrap.js"]
