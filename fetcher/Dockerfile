FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /srv/fetcher
COPY dist/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
