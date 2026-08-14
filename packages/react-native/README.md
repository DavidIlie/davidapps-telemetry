# `@davidapps/telemetry-react-native`

Pure-JavaScript OpenTelemetry tracing for React Native and Expo. It exports OTLP/HTTP to a self-hosted ingest gateway and uses `@davidapps/telemetry-core` for consent, redaction and the public capture API.

This first release intentionally sends events, exceptions, logs and measurements as trace spans. It does not include session replay, user/device fingerprinting, native crash handling or a durable offline queue.

## Install

```sh
pnpm add @davidapps/telemetry-core @davidapps/telemetry-react-native
```

The OpenTelemetry versions are pinned because its JavaScript SDK does not yet guarantee React Native compatibility across minor releases.

## Expo usage

```tsx
import { AppState } from "react-native";
import {
  TelemetryErrorBoundary,
  createScreenTracker,
  initReactNativeTelemetry,
} from "@davidapps/telemetry-react-native";
import { createExpoTelemetryResource } from "@davidapps/telemetry-react-native/expo";

const telemetry = initReactNativeTelemetry({
  endpoint: "https://random-project.telemetry.example",
  publicKey: "public-mobile-routing-id",
  resource: createExpoTelemetryResource({
    serviceName: "my-app-mobile",
    environment: __DEV__ ? "development" : "production",
    commitSha: process.env.EXPO_PUBLIC_GIT_SHA,
  }),
  appState: AppState,
  // `traceparent` is only sent to explicitly trusted origins.
  fetch: { propagateTraceHeadersTo: ["https://api.example.com/"] },
});

const screens = createScreenTracker(telemetry.client);

// Call after the first usable screen commits.
telemetry.startup.markInteractive({ "screen.name": "Home" });

export function Root() {
  return (
    <TelemetryErrorBoundary client={telemetry.client} fallback={null}>
      {/* app */}
    </TelemetryErrorBoundary>
  );
}
```

For React Navigation, pass the navigation ref to `screens.onReady(ref)` and `screens.onStateChange(ref)`. For Expo Router, call `screens.track(pathname)` from a component observing `usePathname()`.

Call `await telemetry.shutdown()` when permanently tearing down the runtime. It flushes queued spans and restores fetch/error/lifecycle handlers installed by this instance.

`publicKey` is sent as `x-api-key`. It is a rotatable routing identifier compiled into the mobile bundle, not a secret. Use `headers` only for additional public headers.

The provider is local by default, which makes development reloads and coexistence with another SDK safe. Set `registerGlobal: true` only when other OpenTelemetry instrumentation needs the DavidApps provider; OpenTelemetry globals cannot be cleanly replaced after registration.

## Security and privacy

- The ingest origin is always excluded from fetch instrumentation, preventing export recursion.
- Query strings and fragments are removed from captured URLs.
- Trace propagation is disabled unless the destination is explicitly allowlisted.
- Request/response bodies, headers, cookies and route params are never captured.
- An endpoint hostname or mobile write token is public information, not a secret. Enforce project identity, limits and protected resource attributes at the ingest gateway.

`BatchSpanProcessor` provides a bounded in-memory queue. Applications may lose the final batch when the OS kills the process; the `AppState` helper reduces this risk by flushing on background. Durable storage belongs in a later opt-in adapter.

## Upstream and licensing

The implementation uses published Apache-2.0 OpenTelemetry dependencies. No source code was copied from another SDK. API choices were validated against the official OpenTelemetry React Native demo and the OpenTelemetry JS SDK.
