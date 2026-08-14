# Architecture

The package layout follows the same core-plus-adapters shape used by libraries such as Auth.js:

```text
application
  -> @davidapps/telemetry-{web,node,next,react-native}
       -> @davidapps/telemetry-core
            -> stable client API, redaction, sampling, hooks

browser/mobile -> project ingest hostname -> telemetry-gateway -> Alloy
server          ---------------------------> Alloy
                                                    |-> Tempo
                                                    |-> VictoriaLogs
                                                    `-> Prometheus
```

`@davidapps/telemetry-core` owns behavior shared by every runtime. It does not start an SDK, touch globals, or choose a transport. Each adapter owns only the integration required by its runtime:

- Web uses Grafana Faro for browser errors, web vitals, logs, and tracing.
- Node uses OpenTelemetry and can register a standalone Node SDK from its explicit `register` entrypoint.
- Next uses `@vercel/otel` as its only provider registration and reuses the Node adapter's runtime-light API.
- React Native uses OpenTelemetry's JavaScript trace SDK and an OTLP/HTTP exporter, with Expo and app-lifecycle helpers.

The gateway is deliberately boring. It maps a first-party host to a project, checks origin/routing policy and quotas, then forwards the standard Faro or OTLP payload unchanged. It has no database and no analytics model.

## Correlation contract

Every runtime should attach:

| Attribute | Meaning |
| --- | --- |
| `service.name` | Stable application/service name |
| `service.version` | Exact deployed Git commit SHA |
| `deployment.environment.name` | `production`, `staging`, or local environment |
| `davidapps.project.id` | Stable project registry identifier |

Trace IDs connect spans and logs. `service.version` connects an incident to the source commit. Do not use either value as a metric label unless a bounded recording rule intentionally aggregates it.

