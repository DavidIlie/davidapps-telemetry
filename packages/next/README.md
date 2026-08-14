# `@davidapps/telemetry-next`

Next.js 16 instrumentation backed by `@vercel/otel` and the shared DavidApps
telemetry client.

The package has an explicit runtime boundary:

- `@davidapps/telemetry-next` contains runtime-neutral request-error helpers.
- `@davidapps/telemetry-next/node` registers the Node provider and must only be
  dynamically imported from the Node branch of `instrumentation.ts`.

`telemetry-next` owns provider registration through `@vercel/otel`. It uses the
runtime-light `@davidapps/telemetry-node` adapter and never imports that
package's standalone `/register` SDK entry point.

Because `@vercel/otel` registers tracing but not an OTLP Logs provider by
default, `telemetry.log()` keeps the Node package's structured-console fallback
enabled. Kubernetes stdout therefore reaches VictoriaLogs with active
`trace_id` and `span_id` fields and without registering a second SDK.

```ts
// instrumentation.ts
import type { Instrumentation } from "next";
import {
  createNextRequestErrorHandler,
  type NextRequestErrorHandler,
} from "@davidapps/telemetry-next";

let reportRequestError: NextRequestErrorHandler | undefined;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNextTelemetry } = await import(
    "@davidapps/telemetry-next/node"
  );
  const telemetry = registerNextTelemetry({
    resource: {
      serviceName: "my-next-app",
      serviceVersion: process.env.GIT_SHA,
      environment: process.env.NODE_ENV,
    },
  });

  reportRequestError = createNextRequestErrorHandler({ telemetry });
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => reportRequestError?.(error, request, context);
```

Configure the private Alloy receiver with standard variables:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.observability.svc.cluster.local:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Use `@davidapps/telemetry-web` from `instrumentation-client.ts`; never import
the `/node` entry into client code.
