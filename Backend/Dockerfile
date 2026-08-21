# syntax=docker/dockerfile:1

# =========================================================
# DEPENDÊNCIAS DE BUILD
# =========================================================
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY Engine ./Engine
COPY Backend/package.json ./Backend/package.json

RUN npm ci --workspaces --include-workspace-root


# =========================================================
# BUILD TYPESCRIPT
# =========================================================
FROM node:24-alpine AS build

WORKDIR /app

COPY --from=deps /app ./
COPY Backend ./Backend

RUN npm run build --workspace=Backend


# =========================================================
# DEPENDÊNCIAS DE PRODUÇÃO
# =========================================================
FROM node:24-alpine AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY Engine ./Engine
COPY Backend/package.json ./Backend/package.json

RUN npm ci \
    --workspaces \
    --include-workspace-root \
    --omit=dev


# =========================================================
# RUNTIME
# =========================================================
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Usuário sem privilégios
RUN addgroup -S app && \
    adduser -S app -G app && \
    mkdir -p /app/data/media && \
    chown -R app:app /app/data

COPY --chown=app:app \
    --from=prod-deps /app/node_modules ./node_modules

COPY --chown=app:app \
    --from=prod-deps /app/Engine ./Engine

COPY --chown=app:app \
    --from=prod-deps /app/Backend/node_modules ./Backend/node_modules

COPY --chown=app:app \
    Backend/package.json ./Backend/package.json

COPY --chown=app:app \
    --from=build /app/Backend/dist ./Backend/dist

USER app

WORKDIR /app/Backend

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3333') + '/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

STOPSIGNAL SIGTERM

CMD ["node", "dist/server.js"]
