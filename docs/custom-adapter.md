# Write a custom adapter

Use a custom adapter when a runtime has a maintained standard transport but no
DavidApps package yet. Core provides normalized signals and policy; the adapter
owns provider registration, wire translation, batching, globals, and cleanup.

Do not invent a DavidApps JSON ingestion protocol. Prefer OpenTelemetry or Faro
and an upstream-maintained exporter/instrumentation.

## Minimal adapter

```ts
import {
  createTelemetryClient,
  type Attributes,
  type AttributeValue,
  type TelemetryAdapter,
  type TelemetrySignal,
  type TelemetrySpan,
  type TelemetrySpanOptions,
  type TelemetrySpanStatus,
  type TraceContext,
} from "@davidapps/telemetry-core";

class StandardProtocolAdapter implements TelemetryAdapter {
  constructor(private readonly exporter: StandardExporter) {}

  async send(signal: TelemetrySignal): Promise<void> {
    // Exhaustive switch: TypeScript will flag a future signal kind here.
    switch (signal.type) {
      case "event":
        await this.exporter.event(signal.name, signal.attributes, signal.resource);
        return;
      case "exception":
        await this.exporter.exception(
          signal.exception,
          signal.attributes,
          signal.resource,
        );
        return;
      case "log":
        await this.exporter.log(
          signal.level,
          signal.message,
          signal.attributes,
          signal.resource,
        );
        return;
      case "measurement":
        await this.exporter.measurement(
          signal.name,
          signal.value,
          signal.unit,
          signal.attributes,
          signal.resource,
        );
    }
  }

  startSpan(
    name: string,
    attributes: Attributes = {},
    options: TelemetrySpanOptions = {},
  ): TelemetrySpan {
    const span = this.exporter.startSpan(name, attributes, options.kind);
    return {
      setAttribute(key: string, value: AttributeValue) {
        span.setAttribute(key, value);
        return this;
      },
      recordException(error: unknown, extra: Attributes = {}) {
        span.setAttributes(extra);
        span.recordException(error);
        span.setErrorStatus();
      },
      setStatus(status: TelemetrySpanStatus, message?: string) {
        span.setStatus(status, message);
        return this;
      },
      end() {
        span.end();
      },
    };
  }

  currentTraceContext(): TraceContext | undefined {
    return this.exporter.currentTraceContext();
  }

  flush(): Promise<void> {
    return this.exporter.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }
}

const telemetry = createTelemetryClient({
  adapter: new StandardProtocolAdapter(exporter),
  resource: {
    serviceName: "example-runtime",
    serviceVersion: deployedSha,
    commitSha: deployedSha,
    environment: "production",
    attributes: { "davidapps.project.id": "example" },
  },
});
```

`StandardExporter` is illustrative, not an exported package type. Translate it
to the chosen upstream SDK.

## Required semantics

### `send`

- Accept all four `TelemetrySignal` variants.
- Preserve `id` and `timestamp` when the target protocol supports them.
- Map resource identity consistently, especially `service.name`, exact
  `service.version`, environment, repository revision, and the nested
  `davidapps.project.id` attribute.
- Treat `send` as best effort. Throw/reject on a real transport failure so core
  can report it through debug/`onError`; do not throw merely because a provider is a
  no-op before registration.
- Do not log the whole rejected signal, because it may contain an exception
  stack or application data.

### Spans and context

- `recordException` must record the exception and set error status.
- `setStatus` must map `unset`, `ok`, and `error`; sanitize/bound its optional
  message if the adapter can be used without the core wrapper.
- `end` must release/end the upstream span once.
- Return a no-op span when the provider cannot create a span.
- `currentTraceContext` returns lowercase hex IDs in standard OTel sizes when
  available.
- State clearly whether `startSpan` installs active context. Core's generic
  `withSpan` cannot make that decision for the adapter. A runtime client may
  subclass `TelemetryClient` as the Node adapter does to implement provider
  `startActiveSpan` semantics.

Never inject trace headers without an explicit destination allowlist. Exclude
the exporter endpoint from automatic network instrumentation to prevent
recursive telemetry.

### Flush and shutdown

- `flush` waits for every adapter/provider batch that it owns.
- `shutdown` is idempotent and stops future transport work.
- Restore a global patch only when the currently installed global is the
  wrapper owned by this instance; do not overwrite another library's later
  patch.
- Document what cannot be flushed or restored.

Core awaits these explicit methods but contains their failures through
debug/`onError`. Capture calls and lifecycle promises remain fail-open. Make
shutdown idempotent in the adapter too, because it may be used independently.

### Consent and sampling

Choose exactly where sampling occurs:

- Core sampling is independent per core call/span.
- Provider trace sampling keeps complete traces.
- Browser session sampling keeps Faro automatic/custom records together.

Avoid multiplying rates accidentally (for example core `0.1` and provider
`0.1` gives roughly one percent for independent decisions).

Core pending/denied consent drops future calls but does not automatically stop
an upstream SDK's automatic instrumentation or erase its batch. Expose or
document the provider pause lifecycle.

## Resource and attribute mapping

Map `TelemetryResource` to standard attributes:

| Resource field | Attribute |
| --- | --- |
| `serviceName` | `service.name` |
| `serviceVersion` | `service.version` |
| `environment` | `deployment.environment.name` |
| `namespace` | `service.namespace` |
| `repositoryUrl` | `vcs.repository.url.full` (and runtime-compatible alias only when necessary) |
| `commitSha` | `vcs.ref.head.revision` |
| `platform` | A documented standard/runtime attribute |
| `attributes` | Preserve keys after validation/conversion |

OpenTelemetry arrays must be homogeneous. The core type permits mixed primitive
arrays, so an adapter must choose a deterministic conversion or reject them.
Document it.

Core sanitizes resource input when the client is created and re-sanitizes
post-`beforeSend` output. Apply adapter-level bounds/redaction when the adapter
can be used independently or upstream automatic instrumentation adds data
outside core.

## Package layout and runtime safety

Keep provider registration in an explicit runtime entrypoint:

```text
packages/example/src/index.ts       runtime-light client/adapter
packages/example/src/register.ts    provider/global setup
```

An Edge/browser import must not evaluate Node built-ins or provider startup.
React must remain an optional peer unless the base adapter actually requires
it. Publish explicit exports and test both ESM and CommonJS artifacts.

## Test matrix

At minimum, add focused tests for:

1. Every signal mapping, resource identity, exact timestamp, and signal ID
2. `measure(name, value, attributes, unit)` argument order and non-finite values
3. Exception status, stack/message handling, and rethrow behavior
4. Span kind/status mapping and idempotent `end()` behavior
5. Disabled, pending, denied, zero/one/fraction sampling
6. Sync/async `beforeSend`, `null` drops, re-sanitization, and hook rejection
   isolation
7. `onError` isolation, flush ordering, shutdown idempotence, and sends after shutdown
8. Trace context validity and propagation allowlist/exclusion
9. URL/body/header redaction and export-recursion prevention
10. Duplicate initialization/provider registration
11. Import safety in every advertised runtime
12. A buildable minimal fixture using the published tarball—not a workspace
    source import
13. End-to-end receipt by Alloy and the final backend

Run repository verification:

```sh
pnpm check
pnpm test
pnpm build
pnpm packages:check
pnpm licenses:check
pnpm upstream:check
pnpm packages:smoke
```

## Upstream provenance

Before adding an upstream dependency or adapted code:

1. Record repository, exact commit, license, and usage type in `UPSTREAM.yml`.
2. Preserve source headers and notices for copied/adapted files.
3. Update `THIRD_PARTY_NOTICES.md`.
4. Prefer a package dependency over copied source when its public extension
   surface is sufficient.
5. Add compatibility notes explaining any pinned version.

Copying code without license/provenance is not acceptable, even for a niche
personal package.
