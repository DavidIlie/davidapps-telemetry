# `@davidilie/telemetry-next`

Next.js 16 server instrumentation backed by `@vercel/otel` and the shared
DavidApps client. It has a strict runtime boundary:

- `@davidilie/telemetry-next` is runtime-neutral and contains request-error
  reporting types/helpers.
- `@davidilie/telemetry-next/node` registers the Node provider and must be
  dynamically imported only from the Node branch of `instrumentation.ts`.

Node.js 20.9 or newer, Next.js 16, and OpenTelemetry API 1.x are supported.

```sh
pnpm add @davidilie/telemetry-next @opentelemetry/api
```

## Server setup

```ts
// instrumentation.ts
import type { Instrumentation } from "next";
import {
  createNextRequestErrorHandler,
  type NextRequestErrorHandler,
} from "@davidilie/telemetry-next";

let reportRequestError: NextRequestErrorHandler | undefined;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNextTelemetry } = await import(
    "@davidilie/telemetry-next/node"
  );

  const deployedSha = process.env.GIT_SHA!;
  const telemetry = registerNextTelemetry({
    resource: {
      serviceName: "storefront",
      serviceVersion: deployedSha,
      environment: process.env.DEPLOYMENT_ENV ?? "production",
      namespace: "storefront",
      repositoryUrl: "https://github.com/example/storefront",
      commitSha: deployedSha,
      attributes: {
        "davidapps.project.id": "storefront",
      },
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

`serviceVersion` and `commitSha` must be the exact immutable SHA deployed in
the running image. `davidapps.project.id` must be nested in
`resource.attributes`.

Configure the private Alloy receiver through standard OTel variables:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.observability.svc.cluster.local:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

`registerNextTelemetry` calls `registerOTel` once per JavaScript global and
returns the same client on repeated calls. Its optional `otel` object accepts
`@vercel/otel` configuration other than `serviceName` and `attributes`, which
are derived from the shared resource contract. Unless `otel.traceSampler` is
provided, registration builds a parent-based ratio sampler from `sampleRate`.
Only a concrete OpenTelemetry `Sampler` is accepted, not `@vercel/otel`'s named
sampler strings. Either sampler is wrapped in a mutable provider-wide gate, so
`telemetry.setEnabled(...)` and `telemetry.setConsent(...)` immediately control
new automatic and client-created spans, including children of sampled parents.
Already queued/exported work is not recalled.

Provider registration owns trace sampling and the Node adapter applies
`sampleRate` once to logs; core does not make a second decision for those
signals. OTel histogram measurements remain aggregated instead of randomly
sampling points.

Measurements default to short trace spans because `@vercel/otel` does not
configure a metrics reader by default. If `otel.metricReaders` is non-empty,
the default becomes OTel metrics. Set `measurementMode: "spans"`, `"metrics"`,
or `"both"` explicitly when the representation must not depend on provider
configuration; metric attributes require `metricAttributeAllowlist`.

Do not import `@davidilie/telemetry-node/register` in a Next.js app. This
package deliberately makes `@vercel/otel` the only provider registration.

## Request errors

`createNextRequestErrorHandler` maps Next's request/context data to bounded
attributes, captures the exception, then awaits the client's core flush as
required by the `onRequestError` lifecycle.

It records:

- `http.request.method` and `url.path`
- `next.router.kind`, `next.route.path`, and `next.route.type`
- Optional render source/type, revalidation reason, and Next error digest
- Static attributes passed to the helper

Request headers are deliberately not captured. Avoid putting path parameters,
queries, or personal identifiers into custom attributes.

```ts
const reportRequestError = createNextRequestErrorHandler({
  telemetry,
  attributes: { "app.surface": "storefront" },
  beforeCapture: async (error, request, context) => {
    // Returning false drops this report. Keep this predicate cheap.
    return context.routeType !== "action" || shouldReport(error);
  },
  onError: (error, stage) => diagnostics.report(stage, error),
});
```

`beforeCapture` may be asynchronous. Hook, capture, flush, and diagnostic-hook
failures are contained so request error reporting never breaks the request.
`onError` receives `beforeCapture`, `capture`, or `flush` as its stage. Let Next
await the returned promise so the reporting attempt reaches its boundary.

The root helper is Edge-import-safe and can accept any reporter implementing
`captureException` plus optional `flush`. Provider registration in this package
is Node-only; an Edge runtime needs an explicitly Edge-safe reporter.

## Browser setup

Server instrumentation does not initialize browser telemetry. Use
`@davidilie/telemetry-web` from `instrumentation-client.ts`:

```ts
// instrumentation-client.ts
import { initializeWebTelemetry } from "@davidilie/telemetry-web";

const deployedSha = process.env.NEXT_PUBLIC_GIT_SHA!;

export const { client: browserTelemetry } = initializeWebTelemetry({
  url: `${process.env.NEXT_PUBLIC_TELEMETRY_URL}/collect`,
  publicKey: process.env.NEXT_PUBLIC_TELEMETRY_KEY,
  resource: {
    serviceName: "storefront-web",
    serviceVersion: deployedSha,
    environment: process.env.NODE_ENV,
    commitSha: deployedSha,
    platform: "web",
    attributes: { "davidapps.project.id": "storefront" },
  },
});
```

Values prefixed `NEXT_PUBLIC_` are visible to every browser user. The endpoint
and public key are routing identifiers, not secrets.

## Logs and shutdown

`@vercel/otel` registers tracing but does not configure an OTLP Logs provider
by default. The returned Node client therefore keeps structured JSON console
logging enabled unless `structuredConsole: false` is set. Kubernetes stdout
reaches VictoriaLogs with active `trace_id`, `span_id`, service, and release.

In long-running Next server processes the framework owns the provider
lifecycle. Do not call `shutdown()` during an ordinary request. Use `flush()`
only at a real lifecycle boundary; it drains core sends, not every private
batch inside `@vercel/otel`.

See the [web adapter](https://www.npmjs.com/package/@davidilie/telemetry-web), [Node adapter](https://www.npmjs.com/package/@davidilie/telemetry-node), [project onboarding](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/adding-a-project.md), and [troubleshooting](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/troubleshooting.md).
