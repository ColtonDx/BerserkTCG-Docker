# syntax=docker/dockerfile:1

# Multi-stage build for the Berserk TCG monorepo.
#
#   target `dev`  — dependencies only; source arrives via bind mount (compose).
#   target `prod` — built client served by the game server in one container.

ARG NODE_VERSION=22-alpine

# --------------------------------------------------------------- dependencies
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Copy only manifests first so `npm ci` is cached until dependencies change.
COPY package.json package-lock.json* ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN npm ci

# ------------------------------------------------------------------------ dev
FROM deps AS dev
ENV NODE_ENV=development
# Source is bind-mounted by docker-compose; compose supplies the command.
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN npm run build

# --------------------------------------------------------------------- runner
FROM node:${NODE_VERSION} AS prod
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/public \
    CARD_DIR=/app/cards

COPY package.json package-lock.json* ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace=@berserk/server --include-workspace-root

COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist public
COPY art-assets/cards cards

# Run unprivileged; the node image ships a `node` user for exactly this.
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
