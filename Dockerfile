# syntax=docker/dockerfile:1
FROM node:24.21.0-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies are pure JavaScript; no dependency install scripts are needed.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.21.0-alpine AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node docs ./docs
COPY --chown=node:node docker/healthcheck.mjs ./docker/healthcheck.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
CMD ["node", "dist/server.js"]
