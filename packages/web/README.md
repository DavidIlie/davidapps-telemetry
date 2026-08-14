# `@davidapps/telemetry-web`

Browser telemetry for the DavidApps Grafana stack. It combines the runtime-neutral `@davidapps/telemetry-core` API with Grafana Faro's browser errors, web vitals, performance timings, console capture, sessions, and OpenTelemetry tracing.

## Install

```sh
pnpm add @davidapps/telemetry-web
```

React is only needed when importing the optional `@davidapps/telemetry-web/react` entry point.

## Initialize early

Call initialization once from the earliest browser-only entry point. It is idempotent, including React Strict Mode remounts.

```ts
import { initializeWebTelemetry } from "@davidapps/telemetry-web";

export const { client: telemetry } = initializeWebTelemetry({
  url: "https://telemetry.example.com/collect/storefront",
  publicKey: "public-storefront-routing-id",
  resource: {
    serviceName: "storefront",
    serviceVersion: import.meta.env.VITE_APP_VERSION,
    environment: import.meta.env.MODE,
    repositoryUrl: "https://github.com/david/storefront",
    commitSha: import.meta.env.VITE_COMMIT_SHA,
    platform: "web",
  },
  tracePropagationTargets: [location.origin, /^https:\/\/api\.example\.com/],
});

telemetry.capture("checkout.completed", { provider: "stripe" });
telemetry.log("warn", "checkout slow", { duration: 814 });
telemetry.measure("checkout.duration", 814, {}, "ms");
telemetry.captureException(new Error("payment failed"));
```

The collector URL is added to Faro's ignored URLs, preventing the telemetry request from creating more telemetry. Trace headers are only propagated to the explicit `tracePropagationTargets` list.

`publicKey` is forwarded as Faro's standard `x-api-key` header. It is a rotatable project routing identifier embedded in the browser bundle, never a secret. The upstream Faro name `apiKey` remains supported as an alias.

`beforeSend` processes custom core signals after built-in redaction. `beforeSendFaro` processes raw Faro transport items, including automatically captured errors and web vitals.

```ts
initializeWebTelemetry({
  url,
  resource,
  beforeSend: (signal) =>
    signal.type === "event" && signal.name === "health.poll" ? null : signal,
  beforeSendFaro: (item) => item,
});
```

Set `enabled: false` or `consent: "pending"` to initialize in a paused state. For applications that should make no telemetry calls at all unless configured, guard initialization on the presence of the public ingest URL.

`sampleRate` uses Faro's session sampler by default, so automatic and manual signals make one consistent sampling decision per browser session. If Faro session tracking is explicitly disabled, the rate only applies to calls through the core client.

## React

The optional component renders nothing. Direct initialization in a browser entry module is preferred because it starts performance instrumentation earlier.

```tsx
import {
  Telemetry,
  TelemetryErrorBoundary,
} from "@davidapps/telemetry-web/react";

<>
  <Telemetry config={config} />
  <TelemetryErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </TelemetryErrorBoundary>
</>;
```

For React 19 root error callbacks, call `reportReactError(error, errorInfo)` from the same entry point. Do not also use `onCaughtError` when `TelemetryErrorBoundary` wraps the same tree, or React will report the caught error twice.

## Scope

Faro automatically captures browser errors, web vitals, performance data, page/view signals, sessions, CSP violations, and configured console levels. This package deliberately does not implement session replay, DOM autocapture, feature flags, or user profiles.

Faro batching does not currently expose a public forced-flush API. `telemetry.flush()` waits for custom core processing, while Faro retains control of its short browser transport batches.
