# `@davidilie/telemetry-core`

Runtime-neutral telemetry client, signal types, sanitization, consent,
sampling, hooks, and adapter contracts. Core does not touch a global SDK or
perform network requests. Most applications should install a runtime adapter;
use core directly to build an adapter or test an integration.

```sh
pnpm add @davidilie/telemetry-core
```

## Create a client

```ts
import {
  createTelemetryClient,
  type TelemetryAdapter,
} from "@davidilie/telemetry-core";

const adapter: TelemetryAdapter = {
  send(signal) {
    // Translate the normalized signal into the runtime's maintained protocol.
    console.log(signal);
  },
};

const deployedSha = process.env.GIT_SHA!;
const telemetry = createTelemetryClient({
  adapter,
  resource: {
    serviceName: "example-worker",
    serviceVersion: deployedSha,
    environment: "production",
    repositoryUrl: "https://github.com/example/example-worker",
    commitSha: deployedSha,
    attributes: { "davidapps.project.id": "example" },
  },
});
```

`resource.attributes` is the extension point for resource identity. In
particular, `davidapps.project.id` must be nested there. Core copies and
sanitizes resource configuration when the client is created, but build metadata
is still trusted input and must never come from request or user-controlled data.

## Client API

All attributes are strings, finite numbers, booleans, or arrays of those
primitive values. `null` and `undefined` values are discarded.

```ts
telemetry.capture("checkout.started", {
  "checkout.provider": "stripe",
});

telemetry.captureException(error, {
  "checkout.stage": "payment",
});

telemetry.log("info", "checkout accepted", {
  "checkout.provider": "stripe",
});

// Signature: measure(name, value, attributes?, unit?)
telemetry.measure(
  "checkout.duration",
  413,
  { "checkout.provider": "stripe" },
  "ms",
);
```

`capture`, `captureException`, `log`, and `measure` return immediately. Core
tracks asynchronous hook and adapter work internally. They do not throw
transport failures back into application code; enable `debug` to print those
failures. A non-finite measurement is ignored.

### Context

```ts
telemetry.setContext({ "account.plan": "pro" });
telemetry.capture("feature.used", { "feature.name": "export" });
telemetry.clearContext();
```

`setContext` merges into the current context. Call attributes override context
attributes with the same key. Context is process/client-wide, so do not use it
for concurrent request identity in a shared server process; put request values
on the individual call or active span instead.

### Spans

```ts
await telemetry.withSpan(
  "invoice.generate",
  async () => {
    await generateInvoice();
  },
  { "invoice.format": "pdf" },
);

const span = telemetry.startSpan("cache.refresh");
span.setAttribute("cache.region", "eu-west");
span.recordException(error);
span.setStatus("error", "refresh failed");
span.end();

await telemetry.withSpan("queue.consume", consume, {}, { kind: "consumer" });
```

`withSpan(name, operation, attributes?, options?)` records a thrown value on
the span, ends it, and rethrows the same value. `options.kind` accepts
`internal`, `server`, `client`, `producer`, or `consumer`. Whether the span becomes active
context is adapter-specific. The Node client does; the generic core fallback
cannot. Prefer `withSpan` over manual `startSpan` when nested operations need
trace correlation.

`startSpan` returns a no-op span while disabled, without granted consent, or
when the adapter has no span implementation. Core wraps real spans so repeated
`end()` calls and mutations after end are safe no-ops. Adapter span failures are
reported without replacing application control flow.

`currentTraceContext()` returns the adapter's current `{ traceId, spanId,
traceFlags? }`, if one exists.

### Lifecycle and consent

```ts
telemetry.setEnabled(false);
telemetry.setConsent("pending");
telemetry.setConsent("granted");

await telemetry.flush();
await telemetry.shutdown();
```

- `enabled: false`, `consent: "pending"`, and `consent: "denied"` drop new
  signals. Pending signals are not queued for later consent.
- Changing enabled or consent state affects new calls and drops accepted work
  still waiting in an asynchronous `beforeSend` hook. It cannot recall work
  already handed to an adapter or exported.
- `flush()` waits for pending core hooks/sends, then calls `adapter.flush()`.
- `shutdown()` stops accepting new signals immediately, drains hook/send work
  accepted before shutdown, then calls `adapter.shutdown()` once. Repeated
  calls return the same promise. Treat a shut-down client as terminal.
- Hook, adapter, span, flush, and shutdown failures are fail-open: they are
  reported to `debug`/`onError` and do not reject client lifecycle promises.

Runtime adapters may own an additional provider or automatic instrumentation
lifecycle. Follow that package's README when changing consent after
initialization.

### Sampling and processing

```ts
const telemetry = createTelemetryClient({
  adapter,
  resource,
  sampleRate: 0.25,
  beforeSend: (signal) => {
    if (signal.type === "event" && signal.name === "health.poll") return null;
    return signal;
  },
  onError: (error, { operation }) => diagnostics.report(operation, error),
  debug: true,
});
```

Core clamps `sampleRate` into `0..1` (a non-finite value becomes `1`) and makes an independent random decision
for each attempted core signal/span. Runtime adapters may move sampling into
their provider to preserve whole-session or whole-trace sampling. `beforeSend`
runs asynchronously after the built-in signal sanitizer and may transform or
drop (`null`) a signal.

The return value of `beforeSend` is sanitized again before adapter delivery.
Hook failures are contained and reported as `beforeSend`. `onError` itself is
also isolated; do not send telemetry from it through the same failing client or
create a reporting loop.

## Built-in sanitization

Core applies bounded, defensive sanitization—not PII discovery:

- At most 64 attributes per call
- Attribute keys at most 128 characters
- Event/span/resource names at most 256 characters; string values at most 2,048
  characters; arrays at most 32 entries
- Exception stacks at most 16,384 characters
- Keys matching authorization, cookie/header/body, password, secret, credential
  token/API key, direct user/account/customer ID, email, phone, or IP patterns
  are removed
- Reserved service/deployment/VCS resource identity cannot be overridden by
  ordinary attributes
- URL-keyed values and URLs found in text lose credentials, query, and fragment
- Bearer/basic credentials, assigned secret-like values, JWT-shaped values, and
  email addresses in text become redaction markers

Redaction is best effort: error messages, stacks, log messages, event names, resource metadata, and
allowed attribute values can still contain private data. Read the repository's
[privacy contract](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/privacy.md).

## Adapter contract

At minimum, implement `send(signal)`. Add `startSpan`, `currentTraceContext`,
`flush`, and `shutdown` only when the transport supports them. Never invent a
DavidApps wire format: translate signals to Faro, OTLP, or another maintained
standard protocol.

See [Write a custom adapter](https://github.com/DavidIlie/davidapps-telemetry/blob/main/docs/custom-adapter.md) for signal mappings,
failure rules, tests, attribution, and a complete skeleton.

## Exports

The package exports `TelemetryClient`, `createTelemetryClient`,
`sanitizeAttributes`, `sanitizeResource`, `sanitizeSignal`, `sanitizeUrl`,
`redactText`, `isSensitiveAttributeKey`, and all public signal/configuration
types. Both ESM and CommonJS builds are published. Node.js 20 or newer is the
supported tooling/runtime baseline, although the core implementation itself is
runtime-neutral.
