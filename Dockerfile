# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund \
 && npm audit --omit=dev --audit-level=moderate

COPY tsconfig.json tsconfig.test.json ./
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
COPY src ./src
RUN npm run build

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
