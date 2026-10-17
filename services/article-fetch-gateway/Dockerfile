FROM node:22-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY services/article-fetch-gateway/package.json services/article-fetch-gateway/package.json
RUN pnpm install --frozen-lockfile
COPY src/articles/url-policy.ts src/articles/url-policy.ts
COPY services/article-fetch-gateway/ services/article-fetch-gateway/
RUN pnpm exec tsc -p services/article-fetch-gateway/tsconfig.json

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /workspace/services/article-fetch-gateway/package.json ./package.json
COPY --from=build /workspace/services/article-fetch-gateway/dist/services/article-fetch-gateway/src ./services/article-fetch-gateway/src
COPY --from=build /workspace/services/article-fetch-gateway/dist/src/articles/url-policy.js ./src/articles/url-policy.js
USER node
EXPOSE 8080
CMD ["node", "services/article-fetch-gateway/src/server.js"]
