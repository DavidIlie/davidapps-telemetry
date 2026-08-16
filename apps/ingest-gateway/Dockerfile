# Pin the base image by digest: a floating tag would let a replaced upstream
# image enter the build supply chain silently. Bump the digest deliberately.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/ingest-gateway/package.json apps/ingest-gateway/package.json
RUN pnpm install --frozen-lockfile
COPY apps/ingest-gateway apps/ingest-gateway
RUN pnpm --filter @davidilie/telemetry-gateway build \
    && pnpm --filter @davidilie/telemetry-gateway deploy --prod --legacy /prod/gateway

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
WORKDIR /app
ENV NODE_ENV=production
USER node
COPY --from=build --chown=node:node /prod/gateway ./
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
