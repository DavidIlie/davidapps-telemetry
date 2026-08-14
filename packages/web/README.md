# `@davidapps/telemetry-web`

Browser telemetry for the DavidApps Grafana stack. It combines the shared core
client with Grafana Faro's browser errors, Web Vitals, performance timings,
console capture, page/view signals, sessions, and OpenTelemetry tracing.

There is no session replay, DOM autocapture, user profile, feature flag, or
PostHog dependency.

## Install and initialize

```sh
pnpm add @davidapps/telemetry-web
```

Initialize once from the earliest browser-only entry point so navigation and
performance instrumentation start early. The package is module-singleton and
safe across React Strict Mode remounts.

```ts
import { initializeWebTelemetry } from "@davidapps/telemetry-web";

const deployedSha = import.meta.env.VITE_GIT_SHA;

export const webTelemetry = initializeWebTelemetry({
  // Faro uses POST /collect. Pass the complete collector URL.
  url: "https://random-project.telemetry.example/collect",
  // Public, rotatable routing identity; never a secret.
  publicKey: "public-project-routing-id",
  resource: {
    serviceName: "storefront",
    serviceVersion: deployedSha,
    environment: import.meta.env.MODE,
    namespace: "storefront",
    repositoryUrl: "https://github.com/example/storefront",
    commitSha: deployedSha,
    platform: "web",
    attributes: {
      "davidapps.project.id": "storefront",
    },
  },
  // Trace headers leave the page only for explicit destinations.
  tracePropagationTargets: [
    location.origin,
    /^https:\/\/api\.example\.com(?:\/|$)/,
  ],
});
export const { client: telemetry, faro } = webTelemetry;

telemetry.capture("checkout.completed", {
  "checkout.provider": "stripe",
});
telemetry.log("warn", "checkout slow", { "checkout.duration_ms": 814 });
telemetry.measure("checkout.duration", 814, {}, "ms");
telemetry.captureException(new Error("payment failed"));
```

`serviceVersion` and `commitSha` must contain the exact deployed commit SHA.
`davidapps.project.id` belongs inside `resource.attributes`.

The collector URL is automatically added to Faro's ignored URLs to prevent
export recursion. The package sends `publicKey` as Faro's `x-api-key` header;
Faro's raw `apiKey` option is intentionally not exposed, keeping the public
routing semantics explicit.

## Configuration

`WebTelemetryConfig` extends Faro's browser configuration except for fields the
package constructs or forbids (`apiKey`, `app`, `url`, `instrumentations`,
`beforeSend`, `metas`, `preserveOriginalError`, and `trackGeolocation`). Useful
additions are:

| Option | Meaning |
| --- | --- |
| `url` | Required full Faro collector URL, normally ending in `/collect` |
| `resource` | Shared service/release/project resource identity |
| `publicKey` | Public routing identifier forwarded as `x-api-key` |
| `enabled` | Start both core and Faro paused when `false` |
| `consent` | `granted` sends; `pending` and `denied` start paused |
| `sampleRate` | Faro session sampling while session tracking is enabled |
| `onError` | Fail-open diagnostics for core/adapter/span/lifecycle failures |
| `beforeSend` | Transform/drop custom core signals after core sanitization |
| `beforeSendFaro` | Transform/drop all raw Faro items, including automatic data |
| `captureConsole` | Configure Faro console capture |
| `enablePerformanceInstrumentation` | Configure Web Vitals/performance capture |
| `enableContentSecurityPolicyInstrumentation` | Configure CSP violation capture |
| `enableTracing` | Add Faro tracing; defaults to `true` |
| `tracePropagationTargets` | Explicit allowlist for cross-service trace headers |
| `additionalInstrumentations` | Append maintained/custom Faro instrumentations |

All remaining compatible Faro options, including `isolate`, `ignoreUrls`,
`paused`, and `sessionTracking`, pass through. A raw `paused: true` controls the
initial Faro state; later `WebTelemetry.setEnabled`/`setConsent` calls are the
authoritative synchronized lifecycle controls and may unpause it.

```ts
initializeWebTelemetry({
  url,
  resource,
  beforeSend: (signal) =>
    signal.type === "event" && signal.name === "health.poll" ? null : signal,
  beforeSendFaro: (item) => item,
});
```

`beforeSend` sees only calls made through the shared client. Use
`beforeSendFaro` to inspect automatic errors, console records, Web Vitals, and
other raw Faro items. Core re-sanitizes the custom signal returned by
`beforeSend`. A mandatory deep Faro privacy pass runs before and after
`beforeSendFaro`, covering automatic metadata, messages, contexts, errors, and
OTLP attributes. Direct identifiers and `originalError` are dropped;
URLs/text are scrubbed. A broken privacy/user hook drops the item instead of
sending it or breaking the page.

`sanitizeFaroTransportItem` and `createPrivacyBeforeSend` are exported for
testing or composing a maintained custom instrumentation.

## Consent, sampling, and lifecycle

Initializing with `enabled: false`, `consent: "pending"`, or
`consent: "denied"` pauses Faro and drops core calls; it does not buffer them.
Use the returned runtime methods so core and Faro remain aligned:

```ts
// Grant after a consent UI decision.
webTelemetry.setConsent("granted");

// Revoke.
webTelemetry.setConsent("denied");

webTelemetry.setEnabled(false);
```

Calling `client.setConsent`/`setEnabled` directly controls custom core calls
only; prefer `WebTelemetry.setConsent`/`setEnabled` for application lifecycle.

With Faro session tracking enabled (the default), `sampleRate` is one decision
for the Faro session, keeping automatic and custom transported items together.
If `sessionTracking.enabled` is explicitly `false`, the core client applies
per-call sampling instead.

`client.flush()` waits for core hook/adapter work, but Faro does not expose a
public forced-flush API for its transport batch. `shutdownWebTelemetry()`
delegates to the active runtime's idempotent `shutdown()`, clears this package's
active reference, and pauses Faro; it is not a full removal of every global
listener installed by Faro. Normally initialize once for the life of the page.

`getWebTelemetry()` and `getWebTelemetryClient()` return the active singleton,
or `undefined` before initialization/after shutdown. Repeated initialization
with the same routing/resource fingerprint returns the first instance; a
different identity throws instead of silently using stale routing. An existing
global Faro instance also throws. Initialize this package first, or use
`isolate: true` when isolation is intentional.

## React

React is required only for the optional `@davidapps/telemetry-web/react`
entrypoint.

```tsx
import {
  Telemetry,
  TelemetryErrorBoundary,
  reportReactError,
} from "@davidapps/telemetry-web/react";

<>
  <Telemetry config={config} onReady={({ client }) => setClient(client)} />
  <TelemetryErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </TelemetryErrorBoundary>
</>;
```

The `Telemetry` component renders nothing and initializes in an effect. Direct
initialization is preferred when early performance data matters.

For React 19 root callbacks, call `reportReactError(error, errorInfo)`. Do not
also report `onCaughtError` when `TelemetryErrorBoundary` wraps the same tree,
or the same error will be captured twice. The boundary accepts a client,
fallback node/function, and `onError` callback; it does not retry/reset itself.

## What reaches the backends

| Input | Result |
| --- | --- |
| `capture` | Faro event in VictoriaLogs |
| `captureException` / browser errors | Faro exception in VictoriaLogs, with trace context when available |
| `log` / captured console | Faro log in VictoriaLogs |
| `measure` / Web Vitals | Faro measurement in VictoriaLogs |
| Manual and fetch/document-load spans | Faro trace output forwarded to Tempo |

Faro stores browser session IDs for operational grouping. They are not user
identity and do not create a durable analytics profile.

## Security notes

`publicKey`, the randomized hostname, `service.name`, release metadata, and
every browser payload are visible to the browser user. The key selects a
gateway route; it is not authentication. An untrusted client can replay it,
omit/spoof `Origin` outside a browser, and forge payload resource attributes.
Use the gateway for abuse bounds and routing, never authorization, billing, or
trusted actor identity.

Do not capture request/response bodies, cookies, headers, form values, email
addresses, or full URLs with query strings. See the repository
[privacy contract](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/privacy.md) and [analytics recipes](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/analytics-recipes.md).
