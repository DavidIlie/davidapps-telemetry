# `@davidilie/telemetry-node`

OpenTelemetry-backed events, logs, measurements, exceptions, and spans for
Node.js. Use the `/register` entrypoint in a standalone process. Use the root
entrypoint when a framework already owns the OpenTelemetry provider.

Node.js 20 or newer is supported. The package publishes ESM and CommonJS.

```sh
pnpm add @davidilie/telemetry-node @opentelemetry/api
```

## Standalone Node.js

Import registration before modules that need to be auto-instrumented.

```ts
import { registerNodeTelemetry } from "@davidilie/telemetry-node/register";

const deployedSha = process.env.GIT_SHA!;
const telemetry = registerNodeTelemetry({
  resource: {
    serviceName: "email-worker",
    serviceVersion: deployedSha,
    environment: process.env.DEPLOYMENT_ENV ?? "production",
    namespace: "notifications",
    repositoryUrl: "https://github.com/example/email-worker",
    commitSha: deployedSha,
    attributes: {
      "davidapps.project.id": "notifications",
    },
  },
});

await telemetry.withSpan(
  "jobs.process",
  async () => {
    telemetry.capture("job.started", { "messaging.destination.name": "email" });
  },
  { "job.type": "email" },
);

process.once("SIGTERM", async () => {
  await telemetry.shutdown();
  process.exit(0);
});
```

`registerNodeTelemetry` installs one `NodeSDK` per JavaScript global. Repeated
calls return the first client and ignore later configuration until that client
successfully shuts down. Do not register this package beside another provider.

The optional `sdk` property accepts `NodeSDKConfiguration` fields other than
`resource` and `serviceName`. Use it for maintained instrumentations, readers,
processors, or exporters when environment-based defaults are insufficient.

## Export configuration

The standalone SDK follows standard OpenTelemetry environment variables. For
Alloy's private OTLP/HTTP receiver:

```sh
OTEL_SERVICE_NAME=email-worker
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.observability.svc.cluster.local:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Set `OTEL_TRACES_EXPORTER=none`, `OTEL_LOGS_EXPORTER=none`, or
`OTEL_METRICS_EXPORTER=none` to disable a signal. Configure resource data in the
JavaScript `resource` object above; it remains the package's canonical mapping.

Server workloads should use private Alloy directly. Do not put the public
browser/mobile routing key on a server unless the workload genuinely runs
outside the cluster and the gateway has intentionally enabled that signal.

## Existing provider

Frameworks such as Next.js may already own provider registration. Create only
the client from the runtime-light root entrypoint:

```ts
import { createNodeTelemetry } from "@davidilie/telemetry-node";

const telemetry = createNodeTelemetry({
  resource: {
    serviceName: "web",
    serviceVersion: process.env.GIT_SHA,
    environment: process.env.DEPLOYMENT_ENV,
    commitSha: process.env.GIT_SHA,
    attributes: { "davidapps.project.id": "web" },
  },
});
```

Without a registered provider, trace and metric API calls are no-ops. The
structured-console log path still works.

## Client configuration

| Option | Behavior |
| --- | --- |
| `resource` | Required shared service/project/exact-release identity |
| `enabled` / `consent` | Gate future client-created signals; pending/denied do not queue |
| `sampleRate` | `0..1`; standalone registration applies it once to root traces and logs, while metrics remain aggregated rather than randomly sampled |
| `beforeSend` | Async transform/drop hook with a second sanitization pass |
| `debug` / `onError` | Contained telemetry diagnostics |
| `instrumentationName` / `instrumentationVersion` | OTel tracer/logger/meter library identity; not application release identity |
| `structuredConsole` | JSON stdout/stderr fallback, default `true` |
| `measurementMode` | `spans`, `metrics`, or `both` |
| `metricAttributeAllowlist` | Bounded signal keys allowed on metric points |
| `maxMetricInstruments` | Maximum histogram name/unit pairs, default 64 |
| `sdk` | `/register` only: provider configuration excluding resource/service name |

Do not put the deployed commit into `instrumentationVersion`; it belongs in
resource `serviceVersion`/`commitSha`. The instrumentation version identifies
the instrumentation library itself.

## Signal mapping

| Core call | Node behavior |
| --- | --- |
| `capture(name, attrs)` | Adds an event to the active span; otherwise creates and ends a short internal span containing the event |
| `captureException(error, attrs)` | Records on the active span and marks it error; otherwise creates an `exception` span |
| `log(level, message, attrs)` | Emits through the OTel Logs API and, by default, one JSON line to stdout/stderr |
| `measure(name, value, attrs, unit)` | By default records a short `measurement:<name>` trace span; can instead/additionally record an OTel histogram |
| `withSpan(name, operation, attrs, options)` | Creates an active span with an optional portable kind, records/rethrows application failures, and always ends it |

Measurements default to spans so they remain observable without an OTel metric
reader. Configure the representation explicitly when needed:

```ts
const telemetry = registerNodeTelemetry({
  resource,
  measurementMode: "both", // "spans" (default), "metrics", or "both"
  metricAttributeAllowlist: ["checkout.provider"],
  maxMetricInstruments: 32,
  sdk: {
    metricReaders: [reader],
  },
});
```

When `/register` sees configured `sdk.metricReaders`, its default mode becomes
`metrics`; otherwise it is `spans`. A framework client chooses the mode supplied
by the caller. Histogram names must match the adapter's bounded instrument-name
syntax, and no more than 64 name/unit pairs are created by default. Only
explicitly allowlisted signal attributes reach metric points; resource labels
come from the provider. Metrics still require a reader/exporter.

### Structured logs and correlation

JSON console output is enabled by default so Kubernetes log collection reaches
VictoriaLogs even when the framework provider did not configure OTel Logs. It
includes `service_name`, `service_version`, and active `trace_id`/`span_id`.

```ts
const telemetry = createNodeTelemetry({
  resource,
  structuredConsole: false, // OTel Logs is the sole desired route.
});
```

The default can duplicate a logical log if both stdout and OTLP Logs are
collected into the same backend. Disable one route deliberately.

## Spans and context

The `NodeTelemetryClient` overrides the generic core `withSpan` so the new span
is active during the operation. Use it when events/logs need the same trace.
`client.startSpan()` creates a span but does not make it active.

Both methods accept `{ kind: "internal" | "server" | "client" | "producer" |
"consumer" }` after attributes. Manual span handles also expose
`setStatus("unset" | "ok" | "error", message?)`.

The package also exports provider-level helpers:

```ts
import {
  currentTraceContext,
  recordException,
  startSpan,
  withSpan,
} from "@davidilie/telemetry-node";
```

These use the globally registered provider and do not add a client's resource
mapping, context, or `beforeSend`. They sanitize their direct names,
attributes, exceptions, and status text, but do not consult a root client's
per-call consent/sampling; only the globally registered provider's policy can
gate them. Use the initialized client for application signals and reserve these
helpers for reviewed provider integrations. `withSpan` establishes active
context; `startSpan` does not.

## Failure, consent, and lifecycle behavior

- Core capture calls isolate hook/export errors from the application.
- `withSpan` rethrows the application's failure after recording it.
- `enabled: false`, pending consent, and denied consent skip new client calls;
  they do not buffer for later.
- Standalone registration wraps a parent-based trace-ratio sampler in a mutable
  collection gate. `setEnabled` and `setConsent` update that provider-wide gate
  immediately, including for automatic instrumentation and sampled-parent
  spans. A custom `sdk.sampler` replaces the ratio sampler but remains inside
  the gate.
- The standalone client does not sample traces twice: the provider owns span,
  event, and exception trace decisions, while the adapter applies `sampleRate`
  once to logs. OTel histogram measurements are aggregated without random
  point sampling. A root-entrypoint client has no provider ownership, so its
  core per-call gate and an externally configured provider sampler can both
  apply; set one layer to `1` if multiplied rates are not intentional.
- State changes affect new work and do not erase an already exported or queued
  provider batch.
- `flush()` drains core work, but the Node adapter does not own a provider
  force-flush method. `shutdown()` on the `/register` client shuts down the
  `NodeSDK` and its processors.
- Only a client returned by `/register` owns and shuts down the installed
  `NodeSDK`. A client created from the root entrypoint does not own the
  framework provider.
- `onError(error, context)` receives contained hook/adapter/span/lifecycle
  failures. Its own failure is ignored; never recurse into the same client.

See the [core API](https://www.npmjs.com/package/@davidilie/telemetry-core), [privacy rules](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/privacy.md), and
[troubleshooting guide](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/troubleshooting.md).
