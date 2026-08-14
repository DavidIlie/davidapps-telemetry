# Add a project

Project onboarding is a small contract between the application, the DavidApps cluster, and the home observability cluster.

## 1. Choose the runtime adapter

- Next.js: `@davidapps/telemetry-next` on the server and `@davidapps/telemetry-web` in the browser.
- Other Node.js services: `@davidapps/telemetry-node`.
- Vite/React or browser applications: `@davidapps/telemetry-web`.
- Expo/React Native: `@davidapps/telemetry-react-native`.

Keep the initializer in one application-owned module. Feature code should import that initialized client rather than creating additional SDK providers.

## 2. Define resource identity

Set these at build/deploy time:

```ts
const resource = {
  "service.name": "example-web",
  "service.version": process.env.GIT_SHA,
  "deployment.environment.name": process.env.DEPLOYMENT_ENV,
  "davidapps.project.id": "example",
}
```

Expose only non-secret values to a client bundle. The commit must be the immutable deployed SHA, not `main` or `latest`.

## 3. Register public ingest

In the DavidApps cluster values, add a project entry with a dedicated first-party hostname, exact allowed origins, a rotatable public routing key, rate limits, and only the signal paths the project needs. Browser and mobile clients use that hostname. Server workloads use Alloy's private OTLP service.

## 4. Add observability-as-code

In the home cluster, add or update the project's Grafana folder and dashboards. The minimum dashboard covers request/span rate, latency, errors, recent correlated logs, and a source link derived from `service.version`. Add alerts only for symptoms that need action.

## 5. Verify one end-to-end signal

Deploy a canary commit, emit one named span and one handled exception, then confirm:

1. The public endpoint returns `202` for an allowed origin and rejects an unregistered origin.
2. Tempo finds the span by `service.name` and `service.version`.
3. VictoriaLogs shows the exception with the same trace ID.
4. The Grafana source link opens the exact commit.
5. Gateway and Alloy metrics show no sustained rejects, retries, or dropped data.

Record the final hostname, project ID, dashboard UID, and owners in the target GitOps repository—not in the SDK.

