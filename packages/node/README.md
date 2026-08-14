# `@davidapps/telemetry-node`

OpenTelemetry-backed events, logs, measurements, exceptions, and spans for
Node.js. The default entry point only uses the registered OpenTelemetry APIs,
so frameworks such as Next.js can provide the SDK without a second provider.

## Standalone Node.js

Import the explicit registration entry before importing instrumented modules:

```ts
import { registerNodeTelemetry } from "@davidapps/telemetry-node/register";

const telemetry = registerNodeTelemetry({
  resource: {
    serviceName: "worker",
    serviceVersion: process.env.GIT_SHA,
    environment: process.env.NODE_ENV,
  },
});

await telemetry.withSpan("jobs.process", async () => {
  telemetry.capture("job.started", { queue: "emails" });
});
```

The standalone registration follows standard OpenTelemetry environment
variables. For Alloy's OTLP/HTTP receiver:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.observability.svc.cluster.local:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Set `OTEL_TRACES_EXPORTER=none`, `OTEL_LOGS_EXPORTER=none`, or
`OTEL_METRICS_EXPORTER=none` to disable an individual signal.

`telemetry.log()` also writes one JSON record to stdout/stderr by default. The
record includes `service_name`, `service_version`, and the active `trace_id`
and `span_id`, allowing Fluent Bit and VictoriaLogs to correlate Kubernetes
logs even when the framework provider does not configure the OpenTelemetry
Logs SDK. Set `structuredConsole: false` if OTLP logs are the only desired
path.

## Existing OpenTelemetry provider

When a framework already registered OpenTelemetry, create only the client:

```ts
import { createNodeTelemetry } from "@davidapps/telemetry-node";

const telemetry = createNodeTelemetry({
  resource: { serviceName: "web" },
});
```

`withSpan` installs an active context and records thrown exceptions before
rethrowing them. The package also exports `startSpan`, `withSpan`,
`currentTraceContext`, and `recordException` for code that uses the registered
provider without creating a client. `captureException` never swallows
application errors.
