FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server.ts ./server.ts
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts/benchmark-http.mjs ./scripts/benchmark-http.mjs
COPY --from=build --chown=node:node /app/scripts/benchmark-ws.mjs ./scripts/benchmark-ws.mjs

RUN mkdir -p /app/server/data && chown -R node:node /app/server/data

USER node

EXPOSE 3000

CMD ["node", "--import", "tsx", "server.ts"]
