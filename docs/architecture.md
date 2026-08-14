# Architecture

The package layout follows a core-plus-adapters shape similar to Auth.js:

```text
feature code
  -> stable TelemetryClient API
       -> core policy: consent, sampling, sanitization, beforeSend
            -> runtime adapter
                 browser ------------ Faro /collect -------+
                 React Native ------- OTLP /v1/traces ------+-> public gateway
                 Node / Next -------- private OTLP ---------+       |
                                                                  Alloy
                                       +--------------------------+--+------------------+
                                       |                             |                  |
                                     Tempo                     VictoriaLogs        Prometheus
                                     traces                       logs              metrics
```

`@davidilie/telemetry-core` owns the stable API and normalized signal contract.
It does not start an SDK, touch globals, or choose a transport. Runtime adapters
translate that contract into maintained standard protocols:

- Web delegates browser instrumentation and transport to Grafana Faro.
- Node uses registered OpenTelemetry APIs and optionally owns a standalone
  `NodeSDK` from its explicit `/register` entrypoint.
- Next uses `@vercel/otel` as its only provider and reuses the Node client.
- React Native owns a local OTel trace provider/OTLP exporter plus reversible JS
  fetch, error, navigation, and lifecycle helpers.

The gateway is an untrusted-client ingress boundary, not a telemetry backend.
It selects a project from the hostname, enforces route/origin/key/rate/body
policy, and forwards the standard payload. Alloy performs the fan-out. Tempo,
VictoriaLogs, and Prometheus remain the systems of record.

## Signal-to-backend matrix

The same core call has a deliberately runtime-specific representation:

| Input | Web | Node / Next | React Native | Primary query backend |
| --- | --- | --- | --- | --- |
| `capture` | Faro event | Active-span event or short trace span | Short trace span plus event | VictoriaLogs for web; Tempo for Node/mobile |
| `captureException` | Faro exception | Exception on active span or short error span | Short error span | VictoriaLogs for web; Tempo for Node/mobile |
| `log` | Faro log | OTel log plus JSON stdout by default | Short span with log event | VictoriaLogs for web/Node; Tempo for mobile |
| `measure` | Faro measurement | Short `measurement:<name>` span by default; OTel histogram or both when configured | Short span with measurement attributes | VictoriaLogs for web; Tempo by default for Node/mobile; Prometheus for configured Node metrics |
| `withSpan` / `startSpan` | Faro OTel trace | OTel trace | OTLP trace | Tempo; derived span metrics in Prometheus |
| Automatic page/Web Vitals/browser errors | Faro | N/A | N/A | VictoriaLogs; browser traces in Tempo |
| Automatic fetch/navigation/startup/JS errors | N/A | Framework/instrumentation dependent | OTLP trace spans | Tempo |
| Kubernetes stdout | N/A | Structured application/container logs | N/A | VictoriaLogs |

Prometheus receives native application OTLP metrics only when the Node provider
has a metric reader/exporter and `measurementMode` includes `metrics`. Metric
points keep only explicitly allowlisted signal attributes. Tempo's metrics
generator separately derives span-rate, latency, error, and service-graph
series from traces. A call to `measure` is therefore not guaranteed to create a
Prometheus series in every runtime.

## Correlation and release contract

Use one immutable identity on every runtime for a deployed artifact:

```ts
const deployedSha = process.env.GIT_SHA!;

const resource = {
  serviceName: "storefront-web",
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

| Resulting OTel attribute | Source field | Meaning |
| --- | --- | --- |
| `service.name` | `serviceName` | Stable deployed service/runtime name |
| `service.version` | `serviceVersion` | Exact deployed commit SHA |
| `deployment.environment.name` | `environment` | Stable environment such as `production` |
| `service.namespace` | `namespace` | Stable product/service grouping |
| `vcs.repository.url.full` | `repositoryUrl` | Source repository (web/Node); mobile also emits `app.repository.url` |
| `vcs.ref.head.revision` | `commitSha` | Exact deployed commit SHA |
| `davidapps.project.id` | `attributes["davidapps.project.id"]` | Stable gateway/dashboard project registry ID |

`serviceVersion` and `commitSha` should be the same full SHA. The duplicate
semantic fields make both service-version dashboards and direct source links
straightforward. Never set either to `main`, `latest`, an image tag that can
move, or the telemetry package version.

Trace IDs connect traces with Node/Faro logs. Web Faro records expose their app
and session metadata in VictoriaLogs. The project ID is useful for scope but is
not an authenticated tenant boundary when supplied by a public client.

## Trust boundaries

```text
trusted build/deploy metadata        untrusted browser/mobile payload
            |                                      |
            +-> compiled resource -----------------+
                                                   v
random public host + public key -> route/policy -> gateway -> Alloy
```

- A server exporting over the private cluster network can be treated according
  to the cluster's workload identity and network controls.
- A public key and randomized hostname are visible routing identifiers.
- `Origin` is useful browser policy but can be absent/spoofed by non-browser
  clients.
- Public payload attributes, including project/service/release, are assertions
  by an untrusted client. They must not drive authorization or billing.
- The gateway stores nothing and does not rewrite payload identity. It injects
  the configured project as an upstream routing header only.

## Failure and durability model

Telemetry is best effort and must not take down the application:

1. Core capture calls return immediately.
2. Sanitization and `beforeSend` run before adapter `send`.
3. Hook/transport/span/lifecycle failures are contained and can be observed
   through debug output or an optional `onError` callback.
4. `flush()` waits for core work and requests an adapter flush; adapter failures
   are contained rather than changing application control flow.
5. The gateway preserves Alloy's success status/body; that response proves only
   receiver acceptance, not downstream retention.
6. Alloy batches and routes data to the home stack.
7. Retention and storage durability are owned by each backend, not the SDK.

Revoking consent or disabling collection drops new calls and accepted work
still inside an asynchronous `beforeSend` hook; it cannot recall adapter or
backend data. Shutdown uses a different boundary: it refuses new calls while
draining already accepted core work before adapter shutdown.

Browser transport batches cannot currently be force-flushed through Faro's
public API. Mobile has a bounded in-memory queue, so the last batch can be lost
on OS termination. Standalone Node and Next wrap provider trace sampling in a
mutable collection gate, so client `setEnabled`/`setConsent` changes also cover
new automatic spans. They do not recall already queued/exported work. A Node
client attached to some other framework's provider can gate only its own calls;
the framework owns automatic instrumentation and provider lifecycle. React
Native also wraps its local provider sampler in a mutable collection gate, so
its optional global provider applies client consent/enabled changes to new
third-party spans too.

## Extension boundary

New behavior belongs in core only when every runtime can share its meaning.
Transport/provider/global code stays in an adapter. Prefer official OTel/Faro
instrumentations and semantic conventions over custom wire formats. See
[custom adapter development](custom-adapter.md) and the [signal model](signal-model.md).
