# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root manifests
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# Install dependencies
RUN npm install

# Copy source code
COPY packages/shared/ ./packages/shared/
COPY packages/server/ ./packages/server/

# Build TypeScript
RUN npm run build:shared
RUN npm run build:server

# Stage 2: Runner
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV VAULT_PATH=/data/vault
ENV PORT=3000
ENV HOST=0.0.0.0

# Pre-create vault and app directories with proper ownership for node user
RUN mkdir -p /data/vault /app && chown -R node:node /data /app

# Copy built files from builder stage with proper ownership
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node packages/server/package.json ./packages/server/
COPY --chown=node:node --from=builder /app/packages/server/dist ./packages/server/dist

# Install only production dependencies
RUN npm install --omit=dev

# Volume for the Obsidian Vault folder
VOLUME ["/data/vault"]

EXPOSE 3000

USER node

CMD ["node", "packages/server/dist/index.js"]
