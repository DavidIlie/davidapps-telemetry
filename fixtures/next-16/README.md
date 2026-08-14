# Next.js 16 fixture

This application proves that the browser and server entry points remain in
separate module graphs:

- `instrumentation-client.ts` imports only `@davidilie/telemetry-web`.
- `instrumentation.ts` dynamically imports `@davidilie/telemetry-next/node`
  only when `NEXT_RUNTIME` is `nodejs`.

Builds and tests are offline by default. To send a local deployment to a test
collector, opt in explicitly:

```sh
TELEMETRY_ENABLED=true \
NEXT_PUBLIC_TELEMETRY_ENABLED=true \
NEXT_PUBLIC_TELEMETRY_INGEST_URL=http://localhost:12347/collect \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
pnpm build
```

Do not point the fixture test suite at production telemetry infrastructure.
