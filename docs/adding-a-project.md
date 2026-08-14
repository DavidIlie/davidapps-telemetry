# Add a project

Project onboarding is a contract between application code, the DavidApps
cluster, and the home observability cluster. Finish the identity and query plan
before adding events; otherwise telemetry becomes an expensive pile of strings.

## 1. Choose runtime boundaries

- Next.js: `@davidapps/telemetry-next` for the Node server and
  `@davidapps/telemetry-web` in `instrumentation-client.ts`.
- Standalone Node: `@davidapps/telemetry-node/register`.
- A Node framework that already owns OTel: `@davidapps/telemetry-node` without
  `/register`.
- Vite/React/browser: `@davidapps/telemetry-web`.
- Expo/React Native: `@davidapps/telemetry-react-native`.
- Another runtime: implement `TelemetryAdapter` around a maintained standard
  transport by following [custom-adapter.md](custom-adapter.md).

Keep initialization in one application-owned module. Export the initialized
client from there. Feature modules must not create competing providers or
reinitialize telemetry with different resources.

## 2. Inject the immutable build identity

Produce one exact Git SHA during CI and pass it into the deployed server and
client bundles. The name of the environment variable can vary; its value may
not.

```ts
const deployedSha = process.env.GIT_SHA!;

export const resource = {
  serviceName: "example-web",
  serviceVersion: deployedSha,
  environment: process.env.DEPLOYMENT_ENV ?? "production",
  namespace: "example",
  repositoryUrl: "https://github.com/example/example-web",
  commitSha: deployedSha,
  platform: "node",
  attributes: {
    "davidapps.project.id": "example",
  },
};
```

The SDK accepts camelCase resource fields, not raw OTel keys at the top level.
The following is wrong and silently fails to establish project/release identity:

```ts
// Wrong: these are not TelemetryResource fields.
const resource = {
  "service.name": "example-web",
  "service.version": process.env.GIT_SHA,
  "davidapps.project.id": "example",
};
```

Client-visible environment variables may contain only public values. Never
expose an Alloy private endpoint, cluster credential, or secret through a web
or mobile build.

## 3. Define the event contract

Start with a small table in the application repository:

| Stable event | When it fires | Required attributes | Owner/question |
| --- | --- | --- | --- |
| `signup.started` | User begins the flow | `signup.method` | Where does signup fail? |
| `signup.completed` | Server confirms success | `signup.method` | Completion rate |
| `report.exported` | Export succeeds | `report.format` | Which formats are used? |

Names describe completed domain facts. Do not generate names from values such
as `page./users/123`, and do not attach email addresses, raw user IDs, full
URLs, error messages, trace IDs, or timestamps as metric dimensions. Follow
the [signal taxonomy and cardinality rules](signal-model.md).

If a fact is security-, billing-, or authorization-critical, record it in the
trusted application database/audit system. Public client telemetry is not an
authoritative ledger.

## 4. Register public ingest

In `davidapps-cluster`, add a project gateway entry containing:

- A dedicated first-party randomized hostname
- Exact production/staging browser origins
- A rotatable public routing key
- Per-project rate/burst limits; the deployment owns the gateway-wide body limit
- Only the public signal routes the project needs

Web uses the full `https://host/collect` URL. React Native may use the base host
or full `/v1/traces` URL. Server workloads inside the cluster bypass this
public route and export OTLP directly to Alloy.

The public key is bundled in the app. It protects against accidental routing,
not determined misuse. The gateway cannot authenticate or trust payload
resource attributes.

## 5. Initialize consent and sampling deliberately

Decide before launch:

- Whether operational telemetry is allowed without optional analytics consent
- Which signals are essential versus optional
- Whether web sampling is session-wide and mobile/server sampling is trace-wide
- Whether a user/account correlation key is allowed, and if so how it is
  pseudonymized and rotated

`consent: "pending"` drops signals instead of buffering them. On web, update
consent through the returned `WebTelemetry.setConsent` method so it synchronizes
the core client and Faro pause state. See each adapter README and
[privacy.md](privacy.md).

## 6. Add observability as code

In `home-cluster`, create/update the project's Grafana folder and dashboard.
The minimum scope is:

- Deployment/pod health and restarts
- Gateway outcomes for browser/mobile ingest
- Span throughput, p50/p95 latency, and error ratio
- Web Vitals or mobile startup time when applicable
- Recent errors/logs with trace links
- Active `service.version` and exact repository commit link

Use stable service, span, event, and bounded domain dimensions. Keep raw IDs and
messages in searchable logs/traces rather than Prometheus labels.

Document the read-only queries agents should run for the project. Storage,
retention, alerts, domains, and dashboards remain GitOps-owned—not SDK config.

## 7. Verify end to end

Deploy a canary with a known full SHA and emit a uniquely named test span/event
that contains no private data. Confirm:

1. Web/mobile preflight succeeds for an allowed origin.
2. An invalid key returns `401`, a disallowed browser origin `403`, and a valid
   payload preserves Alloy's successful status/body.
3. Gateway metrics show the expected `project`, `route`, and `result`.
4. Tempo finds the trace using `service.name`, `service.version`, and
   `davidapps.project.id` where that attribute is transported.
5. VictoriaLogs finds relevant Faro/Node logs and their shared `trace_id`.
6. Prometheus shows Tempo-derived span metrics after the generator interval.
7. The dashboard's release link opens the exact deployed commit.
8. No attribute contains query parameters, credentials, direct identifiers, or
   request/response bodies.

A gateway success verifies Alloy's receiver response only. Empty backend
results can also mean batching delay, sampling, query-field mismatch, or
retention; follow [troubleshooting.md](troubleshooting.md).

## 8. Record ownership

Record the service names, project ID, public hostname, allowed origins,
dashboard UID, repository, responsible owner, retention expectation, sampling
rate, and event contract in the application/GitOps repositories. Do not hardcode
deployment-specific domains or keys into this SDK repository.
