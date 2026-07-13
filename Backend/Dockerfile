# Build context is the workspace root (E:\Baileys), not this Backend/ folder —
# @webwhatsapp/engine is a local npm workspace ("file:../Engine"), so both
# Backend/ and Engine/ need to be in the build context together:
#
#   docker build -f Backend/Dockerfile -t webwhatsapp-backend .    (run from E:\Baileys)
#   docker compose up backend                                      (from Backend/, context is set to `..` in docker-compose.yml)
#
# NOTE: `npm ci --workspaces` at the root does NOT hoist every dependency to
# the root node_modules — some (dotenv, mongoose, bcrypt, qrcode, pino-pretty)
# land nested under Backend/node_modules instead. Both locations have to be
# copied into the runtime image, or the server fails at boot with
# MODULE_NOT_FOUND despite the build succeeding.

# ── deps: full install (incl. devDependencies) for the build stage ──────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY Engine ./Engine
COPY Backend/package.json ./Backend/package.json
RUN npm ci --workspaces --include-workspace-root

# ── build: compile TypeScript ────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app ./
COPY Backend ./Backend
RUN npm run build --workspace=Backend

# ── prod-deps: production-only install, kept in its own stage so devDependencies
#    never end up in the final image ─────────────────────────────────────────
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY Engine ./Engine
COPY Backend/package.json ./Backend/package.json
RUN npm ci --workspaces --include-workspace-root --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/Engine ./Engine
COPY --from=prod-deps /app/Backend/node_modules ./Backend/node_modules
COPY Backend/package.json ./Backend/package.json
COPY --from=build /app/Backend/dist ./Backend/dist

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

WORKDIR /app/Backend
EXPOSE 3333
CMD ["node", "dist/server.js"]
