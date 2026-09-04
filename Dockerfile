# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node

# The HTTP transport is the sensible default in a container; stdio needs an attached client.
ENV CAP_MCP_TRANSPORT=http \
    CAP_MCP_HOST=0.0.0.0 \
    CAP_MCP_PORT=3333
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3333/healthz || exit 1

ENTRYPOINT ["node", "dist/cli.js"]
