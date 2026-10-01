# syntax=docker/dockerfile:1

FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3055

WORKDIR /app

# The prototype uses Node built-ins only; Worker tooling is not needed here.
COPY --chown=node:node package.json ./

COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node public ./public

USER node

EXPOSE 3055

CMD ["node", "server.mjs"]
