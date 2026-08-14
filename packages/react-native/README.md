# `@davidapps/telemetry-react-native`

Pure-JavaScript OpenTelemetry tracing for React Native and Expo. It sends
OTLP/HTTP traces through a self-hosted public ingest gateway and uses the shared
core client for consent, sanitization, hooks, and the capture API.

The current adapter represents events, JS exceptions, logs, and measurements
as short trace spans. It does not provide native crash capture, ANR reporting,
session replay, fingerprinting, or a durable offline queue.

## Compatibility and install

- Node.js tooling 20 or newer
- React 18.2 or newer
- React Native 0.75 or newer
- Expo and `expo-constants` 57 or newer for the `/expo` helper

```sh
pnpm add @davidapps/telemetry-react-native
```

The OpenTelemetry dependencies are pinned because its JavaScript SDK does not
guarantee React Native compatibility across arbitrary minor versions. Avoid
overriding those versions without running the package and Expo fixtures.

## Expo setup

```tsx
import { AppState } from "react-native";
import {
  TelemetryErrorBoundary,
  createScreenTracker,
  initReactNativeTelemetry,
} from "@davidapps/telemetry-react-native";
import { createExpoTelemetryResource } from "@davidapps/telemetry-react-native/expo";

const deployedSha = process.env.EXPO_PUBLIC_GIT_SHA!;

export const telemetryRuntime = initReactNativeTelemetry({
  // A base URL becomes /v1/traces; a complete /v1/traces URL is preserved.
  endpoint: "https://random-project.telemetry.example",
  // Public routing identifier compiled into the application.
  publicKey: "public-mobile-routing-id",
  resource: createExpoTelemetryResource({
    serviceName: "storefront-mobile",
    serviceVersion: deployedSha,
    environment: __DEV__ ? "development" : "production",
    namespace: "storefront",
    repositoryUrl: "https://github.com/example/storefront-mobile",
    commitSha: deployedSha,
    attributes: {
      "davidapps.project.id": "storefront",
    },
  }),
  appState: AppState,
  fetch: {
    // `traceparent` is sent only to explicitly trusted destinations.
    propagateTraceHeadersTo: ["https://api.example.com/"],
  },
});

export const telemetry = telemetryRuntime.client;
export const screens = createScreenTracker(telemetry);

export function Root() {
  return (
    <TelemetryErrorBoundary
      client={telemetry}
      fallback={({ error, reset }) => (
        <RecoveryScreen error={error} onRetry={reset} />
      )}
    >
      <App />
    </TelemetryErrorBoundary>
  );
}
```

`createExpoTelemetryResource` can infer the Expo slug/name, app version,
platform, bundle/package ID, build number, runtime version, execution
environment, and a commit exposed as `extra.commitSha` or `extra.gitSha`.
Update ID/channel are explicit options rather than inferred fields. For
DavidApps releases, always override both `serviceVersion` and `commitSha` with
the exact deployed source SHA. An app semantic version is not a source
revision.

The `/expo` helper accepts explicit `serviceName`, `serviceVersion`,
`environment`, `namespace`, `repositoryUrl`, `commitSha`, `platform`, `build`,
`updateId`, `updateChannel`, `runtimeVersion`, and additional `attributes`.
Explicit values win. Otherwise it reads safe Expo constants and maps marketing
version to `app.version`, bundle/package to `app.bundle.id`, build to
`app.build`, and update/runtime/execution metadata to documented `app.*`/`expo.*`
attributes. Expo is optional for the root adapter but required when importing
`@davidapps/telemetry-react-native/expo`.

`davidapps.project.id` belongs in the nested `attributes` object.

## Initialization options

| Option | Behavior |
| --- | --- |
| `endpoint` | Required HTTP(S) OTLP base/full trace URL; credentials are rejected, query/hash removed, and `/v1/traces` normalized |
| `publicKey` | Added as public `x-api-key` routing header |
| `headers` | Additional headers; assume they are recoverable from the app bundle |
| `resource` | Shared service, exact release, environment, and project identity |
| `batch` | Bounded in-memory queue and exporter timings |
| `sampleRate` | Parent-based root trace ratio, clamped to `0..1` |
| `enabled` / `consent` | Gate new core and provider spans; pending/denied do not queue |
| `beforeSend` / `debug` | Core processing hook and diagnostic output |
| `onError` | Fail-open diagnostics for core/adapter/span/lifecycle failures |
| `registerGlobal` | Register the provider/context manager globally; defaults to `false` |
| `fetch` | Fetch instrumentation options, or `false`; enabled by default |
| `errors` | Global JS error options, or `false`; enabled by default |
| `appState` | React Native `AppState`, required to capture/flush transitions |
| `startupStartedAt` | Startup clock origin; defaults to initialization time |

`createReactNativeTelemetry` is an alias for `initReactNativeTelemetry`.

### Batching

```ts
batch: {
  maxQueueSize: 512,
  maxExportBatchSize: 64,
  scheduledDelayMillis: 5_000,
  exportTimeoutMillis: 10_000,
}
```

Values are bounded to valid positive queue/batch/timeout sizes. This queue is
memory-only. The OS can kill the process before its last batch exports; passing
`AppState` reduces that risk by flushing when the app leaves `active`.

## Fetch tracing

Fetch instrumentation is reversible and enabled by default. It records method,
a URL without query/fragment, response status, failures, and duration via the
span. It never records request/response bodies or headers.

```ts
fetch: {
  excludeUrls: [/\/health(?:\?|$)/],
  propagateTraceHeadersTo: ["https://api.example.com/"],
}
```

String matchers parse both URLs, require the same origin, and match an exact
path or its `/`-delimited descendants. This prevents an allowlist for
`https://api.example.com/v1` from matching `/v10` or an attacker hostname.
Malformed strings match nothing; regular expressions use `test`. Trace
propagation is empty by default. Keep the allowlist narrow because
`traceparent` exposes correlation identifiers and changes CORS behavior.

The adapter excludes the entire ingest endpoint origin to prevent recursive
exports. If a product API shares that origin, its calls are also excluded; use
a dedicated ingest hostname.

The patch is global. A second installed instance sees an existing patch and
does not own it. Shutdown restores fetch only if this instance's wrapper is
still installed.

## Errors, navigation, and lifecycle

Global JS errors and unhandled rejections are captured by default. The previous
React Native fatal error handler is called by default, so capture does not
change normal crash behavior. This is best-effort JS reporting: a fatal crash
can terminate before a batch is exported, and native crashes are out of scope.

`errors` accepts common attributes, `callPreviousHandler` (default `true`), and
`captureUnhandledRejections` (default `true`). Passing `false` installs no
global error hooks.

`TelemetryErrorBoundary` captures `error.react_boundary`, accepts common
attributes, a node/function fallback, an `onError` callback, and `resetKeys`.
Its fallback function receives `{ error, reset }`.

```ts
const screens = createScreenTracker(telemetry, { "app.surface": "main" });

// React Navigation
screens.onReady(navigationRef);
screens.onStateChange(navigationRef);

// Expo Router: call when usePathname() changes.
screens.track(pathname);
```

Only the route name/path string and previous name are captured. Route keys and
parameters are deliberately ignored. Duplicate consecutive screens are
deduplicated. Call `screens.reset()` when a new navigation lifetime begins.

Initialization begins an `app.startup` span. Mark the first usable UI commit:

```ts
telemetryRuntime.startup.markInteractive({ "screen.name": "Home" });
```

This ends the startup span and emits
`measure("app.time_to_interactive", duration, attributes, "ms")`. It is
one-shot. Shutdown cancels an unfinished startup span.

With `AppState`, transitions produce `app.state_changed`; leaving `active`
forces a flush by default. Configure those behaviors through
`appStateOptions.attributes`, `captureTransitions`, and `flushOnBackground`.
Both behavior flags default to `true`.

## Provider, consent, and shutdown

The provider is local by default, which is friendly to development reloads and
coexistence with another SDK. Set `registerGlobal: true` only when other OTel
instrumentation must use this provider. OpenTelemetry globals cannot be cleanly
replaced after registration; shutdown restores this package's JS wrappers but
does not unregister the global API provider.

Pending or denied consent drops events; there is no deferred-consent buffer.
The runtime client updates a mutable provider-wide gate, so
`client.setEnabled(...)` and `client.setConsent(...)` immediately control new
built-in and client-created spans. With `registerGlobal: true`, the gate also
covers new spans from third-party OTel instrumentation, including children of a
sampled parent. State changes do not remove already queued/exported spans. Call
`await telemetryRuntime.flush()` at a meaningful background boundary.

Manual/client spans accept a fourth `{ kind }` argument through the core client
and expose `setStatus(status, message?)`. Fetch spans use `kind: "client"` and
mark HTTP/error failures explicitly.

```ts
await telemetryRuntime.shutdown();
```

Shutdown is idempotent. It restores this instance's fetch/error/lifecycle
handlers, cancels unfinished startup tracking, flushes core work, shuts down
the provider, and makes subsequent adapter sends no-ops. Adapter lifecycle
failures are reported to `onError`/debug and contained. Do not reuse it.

## Backend shape

| Input | Tempo representation |
| --- | --- |
| `capture("screen_view")` | Short internal span named `screen_view` with an event |
| `captureException(error)` | Short error span named `exception.<ErrorName>` |
| `log("warn", message)` | Short `log.warn` span with a `log` event |
| `measure("app.time_to_interactive", n, attrs, "ms")` | Short `measurement.app.time_to_interactive` span with measurement attributes |
| `startSpan` / fetch / startup | Normal-duration span; manual/startup default to internal and fetch uses client kind |

Mobile `log()` does not enter VictoriaLogs as an OTLP log in this release; it
is trace data in Tempo. Likewise, mobile measurements are not Prometheus metric
series. Query them as spans/attributes.

## Public-ingest trust boundary

The endpoint, key, app identity, and every payload are visible to anyone who
can inspect the app. They route and rate-limit traffic; they do not authenticate
a user or prove that `service.name`, `service.version`, or
`davidapps.project.id` is truthful. Never base authorization, billing, abuse
attribution, or security audit conclusions on client-supplied telemetry alone.

See [privacy](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/privacy.md), [analytics recipes](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/analytics-recipes.md), and [troubleshooting](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/troubleshooting.md).
