# Compatibility and troubleshooting

Work from producer to final backend. Do not start by changing dashboards: first
prove what the application emitted and where the pipeline stopped.

## Compatibility

| Package | Supported baseline |
| --- | --- |
| Core, Web, Node, React Native tooling | Node.js 20+ |
| Next | Node.js 20.9+, Next.js 16.x, OTel API 1.x |
| Web React entry | React 18.2+ |
| React Native | React 18.2+, React Native 0.75+ |
| Expo helper/current peer contract | Expo and `expo-constants` 57+ |

All npm packages publish ESM and CommonJS entrypoints. Browser initialization
still requires a real `window`; a build tool being able to import the module
does not make `initializeWebTelemetry()` server-safe.

OpenTelemetry packages intentionally use compatible pinned/ranged versions.
Check for duplicate `@opentelemetry/api` copies and do not force unsupported
SDK minors in React Native.

## No signal anywhere

Check in order:

1. The initializer runs exactly once in the intended runtime.
2. `enabled !== false` and consent is `granted`.
3. Sampling is non-zero and the test is repeated enough for a fractional rate.
4. `beforeSend` does not return `null` or reject; inspect `debug`/`onError` for
   contained failures.
5. The resource uses `serviceName`; raw `"service.name"` at the top level is
   not valid input.
6. `davidapps.project.id` is nested under `resource.attributes`.
7. `serviceVersion`/`commitSha` contain the deployed full SHA.
8. Debug mode shows no hook/transport warning.
9. A flush/lifecycle boundary is reached when the runtime may exit/background.

`consent: "pending"` drops; it does not hold data until consent is granted.

## Browser

### `initializeWebTelemetry() is browser-only`

Move initialization into a browser entrypoint, `instrumentation-client.ts`, or
client effect. Do not call it from a Server Component, Next `instrumentation.ts`
Node branch, SSR loader, or build-time module evaluation.

### Configuration changes do nothing

Repeated initialization with the same routing/resource fingerprint returns the
active singleton. A different identity throws so telemetry cannot silently use
stale routing. Find duplicate entrypoints or call `shutdownWebTelemetry()`
before intentional test reinitialization. If another library registered global
Faro first, initialize this package earlier or deliberately pass `isolate: true`.

### Consent was granted but automatic data is absent

The core client and Faro have separate states, synchronized by the returned
runtime:

```ts
webTelemetry.setConsent("granted");
```

On revocation call `webTelemetry.setConsent("denied")`. Calling only
`webTelemetry.client.setConsent(...)` does not change automatic Faro state.

### CORS/preflight failure

- Web `url` must be the complete public `/collect` URL.
- The page's exact origin—including scheme and subdomain—must be registered.
- Confirm `x-api-key` is allowed by preflight and the configured `publicKey`
  matches the host's project.
- An unknown host/disabled route is intentionally indistinguishable as `404`.
- Inspect gateway metrics/outcome logs without printing the key or body.

### Browser spans missing but events exist

Confirm `enableTracing !== false`, check browser compatibility/CSP, and ensure
the Faro receiver sends its trace output to Alloy's trace pipeline. Trace
propagation targets affect outbound correlation, not whether local spans exist.

### Duplicate React errors

Do not report the same caught error from both `TelemetryErrorBoundary` and a
React 19 `onCaughtError` callback. Use root callbacks for uncaught/recoverable
paths and one boundary capture for caught errors.

### `flush()` did not send the final Faro batch

Core flush cannot force Faro's private browser transport batch. Initialize
early, keep the page lifecycle healthy, and treat unload delivery as best
effort.

## Node and Next

### Spans/metrics are no-ops

The root `createNodeTelemetry` uses registered APIs only. A standalone service
must import `@davidapps/telemetry-node/register`; a framework must register its
own provider. Metrics additionally need a reader/exporter.

### Duplicate spans or provider errors

Register one provider:

- Standalone Node: `/register`
- Next.js: `@davidapps/telemetry-next/node` / `@vercel/otel`
- Other framework: its provider plus the root Node client

Never combine Node `/register` with Next registration.

### Child work is not correlated

`client.startSpan()` does not install active context. Use
`await client.withSpan(name, operation, attributes)` in the Node client.

### Logs appear twice

Both OTel Logs and JSON stdout are reaching VictoriaLogs. Set
`structuredConsole: false` when the provider's OTLP Logs pipeline is sufficient,
or disable OTel Logs when container stdout is the intentional route.

### Next Edge build imports Node code

The root `@davidapps/telemetry-next` entry is runtime-neutral. Dynamically import
`@davidapps/telemetry-next/node` only after checking
`process.env.NEXT_RUNTIME === "nodejs"`. Never re-export the Node registration
from client/shared code.

### Request errors are missing

Return/await the `onRequestError` promise, ensure the Node `register` branch ran,
and inspect `beforeCapture`. The helper never records request headers. Search by
normalized `next.route.path`, not a concrete private path.

## React Native and Expo

### Endpoint returns `404`

Pass a base host or a URL ending exactly in `/v1/traces`. The adapter appends
`/v1/traces`; a path such as `/mobile` becomes `/mobile/v1/traces` and must
exist at the gateway. Only HTTP(S) is accepted, URL credentials are rejected,
and query/fragment components are removed.

### No fetch spans

- Fetch patching is disabled with `fetch: false`.
- The entire ingest origin is excluded to avoid recursion.
- An `excludeUrls` matcher may match; URL strings require the same origin plus
  an exact path or `/`-delimited descendant.
- Another telemetry instance may already own the global patch.
- Disabled/pending/denied core state returns no-op spans.

### No `traceparent`

Propagation is deny-by-default. Add the exact API prefix/regular expression to
`propagateTraceHeadersTo`. The server must allow the header through CORS. Do not
allowlist arbitrary third-party URLs.

### Final events disappear on background/crash

Pass React Native `AppState` so leaving active triggers `flush()`. The queue is
memory-only and fatal/native termination can still win. This package is not a
durable crash reporter.

### Mobile logs/measurements absent from VictoriaLogs/Prometheus

Expected in the current release. React Native represents both as spans in
Tempo. Search `log.<level>` and `measurement.<name>` span names.

### Expo release has no source commit

`createExpoTelemetryResource` uses `commitSha` as its default `serviceVersion`
and keeps the store-facing Expo version in `app.version`. Inject the deployed
SHA explicitly when Expo config does not already expose it:

```ts
createExpoTelemetryResource({
  serviceVersion: deployedSha,
  commitSha: deployedSha,
  attributes: { "davidapps.project.id": "storefront" },
});
```

## Gateway and downstream pipeline

Inspect `telemetry_gateway_requests_total` and structured outcome logs for the
configured project/route. Current outcome names and response semantics are
documented in the gateway README; do not assume every upstream success becomes
the same HTTP status.

- Unknown host/disabled signal: route policy
- Forbidden/missing origin: client origin/registry policy
- Invalid key: host/key mismatch
- Rate limited: per-replica token bucket
- Payload/body/content-type error: exporter/gateway limit
- Upstream timeout/unavailable/redirect/rejection: Alloy path or response

An upstream success only proves the gateway received a success from Alloy.
Then check:

1. Alloy receiver/exporter errors and dropped/retried batches
2. Tempo receiver accepted/refused/discarded spans
3. VictoriaLogs fields with `field_names` before assuming a query schema
4. Prometheus metric reader and remote-write health
5. Sampling and backend retention/window

## Data exists but the dashboard is empty

- Confirm the selected datasource: deployment/gateway/application metrics can
  live in a different Prometheus from Tempo-derived span metrics.
- Compare exact service spelling and environment.
- Query the active `service.version`; old dashboards may filter a previous SHA.
- Expand the UTC time range beyond batch/generator delay.
- For Faro, discover flattened field names after receiver/SDK upgrades.
- For Tempo, start with `{ resource.service.name = "..." }`, then add filters.
- Avoid interpreting sampling changes as traffic changes.

## Release link is wrong

The application must set both `serviceVersion` and `commitSha` to the full
deployed SHA. The dashboard must map the project to a known repository rather
than trusting a public client-provided URL. Tags, branches, mutable image tags,
and the telemetry SDK version are not valid release revisions.

## Reporting a package bug

Include package/runtime versions, minimal configuration with all keys/domains
replaced, expected and actual signal mapping, and a minimal reproduction.
Never attach raw payloads containing production URLs, stacks, IDs, bodies,
headers, or credentials.
