# syntax=docker/dockerfile:1

FROM node:20-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3055

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.mjs ./server.mjs
COPY public ./public

USER node

EXPOSE 3055

CMD ["node", "server.mjs"]
