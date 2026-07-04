# syntax=docker/dockerfile:1

FROM node:20-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3055

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node public ./public

USER node

EXPOSE 3055

CMD ["node", "server.mjs"]
