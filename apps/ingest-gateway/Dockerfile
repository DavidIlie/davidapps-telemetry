FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/ingest-gateway/package.json apps/ingest-gateway/package.json
RUN pnpm install --frozen-lockfile
COPY apps/ingest-gateway apps/ingest-gateway
RUN pnpm --filter @davidapps/telemetry-gateway build \
    && pnpm --filter @davidapps/telemetry-gateway deploy --prod --legacy /prod/gateway

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
USER node
COPY --from=build --chown=node:node /prod/gateway ./
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
