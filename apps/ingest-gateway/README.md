# DavidApps Telemetry Gateway

A small, stateless ingress guard in front of Grafana Alloy. It binds owned
hostnames to projects, applies exact browser-origin policy, checks public
routing keys, enforces per-process quotas/body limits, and forwards accepted
standard Faro or OTLP payloads. It has no database, durable queue, analytics
model, or telemetry PVC.

## Routes

| Method/path | Default state | Upstream |
| --- | --- | --- |
| `POST /collect` | Enabled | Alloy Faro `/collect` |
| `POST /v1/traces` | Enabled | Alloy OTLP/HTTP `/v1/traces` |
| `POST /v1/logs` | Disabled | Alloy OTLP/HTTP `/v1/logs` |
| `POST /v1/metrics` | Disabled | Alloy OTLP/HTTP `/v1/metrics` |
| `OPTIONS /*` | Origin-checked preflight | None |
| `GET /healthz` | Always | `200 {"status":"ok"}` |
| `GET /readyz` | Ready only when at least one host is configured | `200` or `503` |
| `GET /metrics` | Always | Prometheus text exposition |

Signal permissions are configurable per project. Unknown hosts and disabled
signal routes return `404`, even when the path exists for another project.

The gateway preserves Alloy's response status and body, including OTLP partial
success responses. It also preserves `Content-Type` and `Retry-After`; Faro's
`X-Faro-Session-Status` response header is forwarded and exposed to browsers.
An upstream connection failure becomes `503`, while an upstream timeout becomes
`504`. Redirects are rejected instead of being followed.

## Configuration

```sh
PORT=8080
HOST=0.0.0.0
ALLOY_FARO_URL=http://alloy.observability.svc.cluster.local:12347
ALLOY_OTLP_URL=http://alloy.observability.svc.cluster.local:4318
MAX_BODY_BYTES=524288
UPSTREAM_TIMEOUT_MS=5000
TELEMETRY_PROJECTS_JSON='[
  {
    "id": "storefront",
    "hosts": ["random-project.telemetry.example"],
    "allowedOrigins": [
      "https://storefront.example",
      "https://www.storefront.example"
    ],
    "publicKey": "public-rotatable-routing-id",
    "ratePerSecond": 20,
    "burst": 40,
    "allowFaro": true,
    "allowTraces": true,
    "allowLogs": false,
    "allowMetrics": false
  }
]'
```

`TELEMETRY_PROJECTS_JSON` must be an array. Each entry requires `id`, `hosts`,
and `allowedOrigins`. Defaults are Faro/traces enabled, logs/metrics disabled,
20 requests/second, and a burst of 40.

Configuration is validated before the server binds. Invalid URLs, origins,
types, rate limits, duplicate project IDs/hosts, and unknown project fields are
fatal. `allowedOrigins: []` is valid for native/server-only ingestion and denies
all browser origins.

Hosts are lowercased for matching. Origins are exact, case-sensitive string
matches; list every intended scheme/host and avoid wildcards. The gateway
handles raw compressed or binary bodies and forwards content type, content
encoding, `traceparent`, `tracestate`, and `baggage`. Faro's
`x-faro-session-id` is forwarded on `/collect`. It injects
`x-davidapps-project` toward Alloy and does not forward the public key.

The project limiter is an in-memory token bucket per gateway process. It is not
shared across replicas, so effective aggregate allowance grows with replica
count and load balancing. Treat it as an abuse bound, not a billing-grade
quota. Restarting a replica resets its buckets.

## Public routing is not authentication

The hostname and `publicKey` are deliberately shipped in browser/mobile code.
Anyone can copy them. Browser CORS prevents an ordinary disallowed page from
reading/sending through the normal browser path, but a non-browser client can
omit or forge `Origin`. The gateway checks origin only when that header is
present.

The gateway forwards the payload unchanged. It does not rewrite or validate
payload resource attributes. Therefore a client can forge `service.name`,
`service.version`, and `davidapps.project.id`; the injected
`x-davidapps-project` header expresses the selected route, not authenticated
end-user identity.

Use the gateway for routing, signal policy, body bounds, and best-effort rate
limits. Do not use it for application authorization, audit trails, fraud
decisions, billing, or trusted user attribution. Sensitive server telemetry
should use private Alloy directly.

## Metrics and logs

`telemetry_gateway_requests_total{project,route,result}` reports:

- `accepted`
- `forbidden_origin`
- `invalid_key`
- `rate_limited`
- `upstream_error`
- `unavailable`
- `preflight`
- `route_disabled`
- `forbidden_method`
- `forbidden_header`
- `body_too_large`
- `request_error`

The counter is process-local and starts at zero after restart. The current
gateway does not expose request latency, body size, or distributed quota state.
Scrape every replica and aggregate with Prometheus.

Automatic HTTP request logging is disabled to avoid recording public payloads,
headers, and noisy health traffic. Each signal request attributable to a
configured project emits one safe structured outcome containing only project,
route, outcome, status, duration, request byte count, and upstream status where
applicable. Unknown hosts intentionally have no attacker-controlled project
label. Outcome logs never contain origins, URLs, public keys, trace/session IDs,
headers, or bodies. Fastify still emits application/startup errors. Do not
enable raw body logging in production.

## Local verification

```sh
TELEMETRY_PROJECTS_JSON='[{"id":"demo","hosts":["localhost"],"allowedOrigins":["http://localhost:3000"],"publicKey":"public-demo"}]' \
ALLOY_FARO_URL=http://127.0.0.1:12347 \
ALLOY_OTLP_URL=http://127.0.0.1:4318 \
pnpm --dir apps/ingest-gateway dev

curl -i -X OPTIONS http://localhost:8080/v1/traces \
  -H 'Origin: http://localhost:3000'
```

Use valid Faro/OTLP fixtures for functional POST tests. A successful upstream
status proves that Alloy accepted the request, not that every downstream
backend retained or indexed it. Complete the check in
Tempo/VictoriaLogs/Prometheus.

Production routing, domains, replicas, network policy, alerts, and retention
belong in the GitOps repositories. See [project onboarding](../../docs/adding-a-project.md) and the [signal matrix](../../docs/architecture.md#signal-to-backend-matrix).
