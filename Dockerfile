# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@12.4.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY server.ts ./
COPY scripts/build-prototype.ts ./scripts/build-prototype.ts
COPY public ./public
RUN pnpm build:prototype

FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3055
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/prototype ./dist/prototype
USER node
EXPOSE 3055
CMD ["node", "dist/prototype/server.mjs"]
