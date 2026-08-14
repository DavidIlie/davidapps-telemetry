# DavidApps Telemetry

Tiny, opinionated telemetry SDKs for one very specific deployment shape: applications send browser, Node.js, Next.js, and React Native signals through Grafana Alloy into Tempo, VictoriaLogs, and Prometheus.

This is not a general analytics platform and it is not a PostHog replacement. It has no PostHog SDK, service, or storage dependency. It exists because the author already runs the Grafana observability stack at home and wanted a small PostHog-shaped client API instead of another data platform. If your infrastructure looks similar, have fun. If it does not, the adapters and interfaces may still be useful.

The public API is intentionally small:

```ts
telemetry.capture("checkout.failed", { provider: "stripe" })
telemetry.captureException(error)
telemetry.log("warn", "provider degraded")
telemetry.measure("checkout.duration", 413, { unit: "ms" })
await telemetry.withSpan("checkout.create", operation)
```

## Packages

- [`@davidapps/telemetry-core`](packages/core): runtime-neutral client, contracts, processing, redaction, and transport interfaces.
- [`@davidapps/telemetry-web`](packages/web): Grafana Faro browser adapter.
- [`@davidapps/telemetry-node`](packages/node): OpenTelemetry Node.js adapter.
- [`@davidapps/telemetry-next`](packages/next): Next.js instrumentation adapter built on the Node package and `@vercel/otel`.
- [`@davidapps/telemetry-react-native`](packages/react-native): React Native and Expo adapter.

The repository also includes a small stateless ingest gateway and a Helm chart. The gateway validates and routes public browser/mobile traffic; Alloy remains responsible for batching and exporting data.

Each package is independently installable. Start with the adapter for the runtime; it brings in the core package. Applications that implement their own adapter can depend on `@davidapps/telemetry-core` directly.

See [the architecture](docs/architecture.md) and [project onboarding protocol](docs/adding-a-project.md). Agents working in this repository should follow [AGENTS.md](AGENTS.md).

## Status

Early development. Do not depend on API stability before `1.0.0`.

## Non-goals

- Feature flags or experiments
- Session replay
- DOM autocapture
- User profiles, cohorts, or funnels
- A telemetry storage backend

## License

Apache-2.0. Adapted upstream files retain their original license and provenance in file headers and `THIRD_PARTY_NOTICES.md`.
