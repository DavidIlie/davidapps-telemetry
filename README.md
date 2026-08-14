# DavidApps Telemetry

Small, opinionated telemetry SDKs for a very specific deployment shape:
browser, Node.js, Next.js, and React Native applications send standard Faro or
OpenTelemetry signals through Grafana Alloy into Tempo, VictoriaLogs, and
Prometheus.

This is not a general analytics platform and it is not a PostHog replacement.
There is no PostHog SDK, service, or storage dependency. It exists because the
author already runs this observability stack at home and wanted one tiny,
PostHog-shaped capture API across his own applications. If your infrastructure
looks similar, have fun. Otherwise, treat the core and adapters as an
Apache-2.0 starting point.

```ts
telemetry.capture("checkout.completed", { "checkout.provider": "stripe" });
telemetry.captureException(error, { "checkout.stage": "payment" });
telemetry.log("warn", "payment provider degraded", { provider: "stripe" });
telemetry.measure("checkout.duration", 413, { provider: "stripe" }, "ms");

await telemetry.withSpan(
  "checkout.create",
  () => createCheckout(),
  { "checkout.provider": "stripe" },
);
```

Calls are fire-and-forget. Use `await telemetry.flush()` at a process or request
boundary when delivery of the in-memory batch matters.

## Packages

| Package | Use it for | Wire/backend shape |
| --- | --- | --- |
| [`@davidilie/telemetry-core`](packages/core) | Shared client, signal contracts, sanitization, consent, sampling, and custom adapters | No network I/O |
| [`@davidilie/telemetry-web`](packages/web) | Browser errors, Web Vitals, performance, logs, events, and tracing | Faro `/collect`; browser traces are carried by Faro |
| [`@davidilie/telemetry-node`](packages/node) | Node events, exceptions, logs, metrics, and active spans | OTLP through the registered OpenTelemetry provider; JSON stdout fallback for logs |
| [`@davidilie/telemetry-next`](packages/next) | Next.js 16 server instrumentation and request-error reporting | `@vercel/otel` as the sole Node provider |
| [`@davidilie/telemetry-react-native`](packages/react-native) | Expo/React Native JS errors, lifecycle, navigation, fetch, events, and spans | OTLP/HTTP traces through `/v1/traces` |

Install the runtime adapter; it brings in core. Depend on core directly only
when implementing a new adapter or library integration.

## Identity contract

Every runtime uses the same resource shape. `serviceVersion` and `commitSha`
must be the exact immutable SHA deployed in that build—not a branch, tag,
container tag, package version, or the SDK's own version.

```ts
const deployedSha = process.env.GIT_SHA!;

const resource = {
  serviceName: "storefront",
  serviceVersion: deployedSha,
  environment: "production",
  namespace: "storefront",
  repositoryUrl: "https://github.com/example/storefront",
  commitSha: deployedSha,
  attributes: {
    "davidapps.project.id": "storefront",
  },
};
```

The nested `attributes` object is intentional. Passing
`"davidapps.project.id"` beside `serviceName` is not part of the API and will
not produce that resource attribute.

## What the stack can answer

- Page and screen performance, Web Vitals, startup time, and slow traces
- Browser, React, Next.js request, Node, and React Native JS errors
- Logs correlated to traces by `trace_id` and `span_id`
- The exact source commit active during a trace or error
- Stable product events, coarse funnels, and retention-like return activity
- Gateway acceptance, rejection, rate-limit, and upstream health

The last two are observability queries over Faro events, not a product
warehouse. There is no identity graph, cohort engine, materialized funnel,
session replay, feature flag service, or experiment engine.

## Documentation

- [Architecture and signal routing](docs/architecture.md)
- [Add a project](docs/adding-a-project.md)
- [Signal and attribute model](docs/signal-model.md)
- [Analytics recipes](docs/analytics-recipes.md)
- [Privacy and redaction](docs/privacy.md)
- [Write a custom adapter](docs/custom-adapter.md)
- [Compatibility and troubleshooting](docs/troubleshooting.md)
- [Release procedure](docs/releasing.md)
- [Gateway project registry](docs/project-registry.md)
- [Repository agent protocol](AGENTS.md)

## Deliberate limits

- No session replay or native mobile crash reporter
- No DOM autocapture
- No feature flags or experiments
- No user profiles, identity resolution, or data warehouse
- No durable mobile offline queue
- No storage in the public gateway

## Status and license

Early development. APIs may change before `1.0.0`.

Apache-2.0. Published dependencies retain their own licenses. Upstream
references and exact commits are recorded in `UPSTREAM.yml`; notices are in
`THIRD_PARTY_NOTICES.md`.
