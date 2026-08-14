# Signal and attribute model

Telemetry stays useful when names and attributes form a small, reviewed
contract. The core API deliberately avoids a warehouse schema, but applications
still need one.

## Choose the signal by question

| Question | API | Naming style | Example |
| --- | --- | --- | --- |
| Did a stable product/domain fact occur? | `capture` | Past-tense dotted fact | `checkout.completed` |
| Did code fail? | `captureException` | Error object plus stage attributes | `captureException(error, { "checkout.stage": "payment" })` |
| What diagnostic message belongs in the timeline? | `log` | Stable message plus structured attributes | `log("warn", "payment provider degraded", { provider: "stripe" })` |
| What numeric distribution should be measured? | `measure` | Dotted noun; explicit unit fourth | `measure("checkout.duration", 413, {}, "ms")` |
| Which operation needs duration and trace children? | `withSpan` | Stable operation name | `checkout.create` |

Do not send the same fact through every signal. An exception on an active trace
usually needs one exception record and error span status, not an exception, log,
event, and measurement with the same payload.

## Public API signatures

```ts
capture(name: string, attributes?: Attributes): void
captureException(error: unknown, attributes?: Attributes): void
log(level: "debug" | "info" | "warn" | "error", message: string, attributes?: Attributes): void
measure(name: string, value: number, attributes?: Attributes, unit?: string): void
startSpan(name: string, attributes?: Attributes, options?: { kind?: TelemetrySpanKind }): TelemetrySpan
withSpan<T>(name: string, operation: () => T | Promise<T>, attributes?: Attributes, options?: { kind?: TelemetrySpanKind }): Promise<T>
```

The measurement unit is not an attribute object:

```ts
telemetry.measure("search.duration", 83, { "search.mode": "fuzzy" }, "ms");
```

Portable span kinds are `internal`, `server`, `client`, `producer`, and
`consumer`. Span handles expose `setAttribute`, `recordException`,
`setStatus("unset" | "ok" | "error", message?)`, and idempotent `end` through
the core client wrapper.

## Event vocabulary

Prefer `{domain}.{past_tense_fact}`:

- `signup.started`, `signup.completed`
- `checkout.started`, `checkout.failed`, `checkout.completed`
- `report.exported`
- `screen_view` and `app.state_changed` are stable built-ins in the mobile
  adapter; keep their existing spelling

Use attributes for bounded variants:

```ts
// Good: one stable event, bounded values.
telemetry.capture("report.exported", {
  "report.format": "pdf",
  "report.kind": "invoice",
});

// Bad: each value creates another event name.
telemetry.capture(`report.exported.${format}.${reportId}`);
```

Fire completion events only after the authoritative operation succeeds. For a
client/server action, the trusted server is the better producer of the success
fact; the client can record intent or UI outcome.

## Attribute naming

Prefer OpenTelemetry semantic conventions where a stable one exists, then use
a domain prefix for application fields:

```text
http.request.method
http.response.status_code
url.path
screen.name
checkout.provider
report.format
feature.name
```

Avoid ambiguous keys such as `type`, `id`, `status`, or `value`. Attribute
values must be string, finite number, boolean, or an array of primitives.

Required resource identity:

```ts
resource: {
  serviceName: "storefront-web",
  serviceVersion: deployedSha,
  environment: "production",
  commitSha: deployedSha,
  attributes: {
    "davidapps.project.id": "storefront",
  },
}
```

The project ID is nested under `attributes`. `serviceVersion` and `commitSha`
are the exact deployed SHA.

## Cardinality rules

Prometheus and Tempo metrics generation are sensitive to unbounded dimensions.
VictoriaLogs/Tempo can search high-cardinality fields, but more dimensions still
increase storage and query cost.

| Usually bounded | Unbounded: never use as a metric label/dimension |
| --- | --- |
| Environment, service, platform | User/account/device IDs |
| HTTP method, normalized route template | Raw URL/path with IDs or query strings |
| Response status class/code | Trace/span/request IDs |
| Feature name from a reviewed enum | Error/log message or stack |
| Provider, plan tier, file format | Timestamp, UUID, random token |
| App version/build/channel | Search text or arbitrary form input |

Rules of thumb:

1. Keep event and span names stable. Put bounded variants in attributes.
2. Use route templates (`/orders/:id`) rather than concrete paths
   (`/orders/7c98...`).
3. If a value can grow with users, requests, records, or time, it is unbounded.
4. Keep correlation IDs in logs/traces only. Do not configure them as Tempo
   span-metric dimensions or Prometheus labels.
5. Prefer fewer than roughly dozens of values for dashboard grouping fields.
6. Review every new dimension before adding it to a recording rule/dashboard.

## User and session correlation

Faro supplies a browser `session_id`; treat it as an ephemeral operational
session, not durable identity. The SDK does not implement `identify`, profiles,
or cross-device identity.

If a product truly needs return-activity analysis, add an application-owned,
pseudonymous, purpose-limited subject key only after privacy review. It should
not be a raw database ID, email, phone number, wallet address, or stable device
fingerprint. Rotation and deletion semantics belong to the application. Never
turn this key into a Prometheus label.

Without such a key, retention-like queries can describe returning browser
sessions or aggregate activity, not returning people.

## Exceptions and logs

Attach a stable stage/operation, not sensitive context:

```ts
telemetry.captureException(error, {
  "checkout.stage": "payment",
  "checkout.provider": "stripe",
  "error.handled": true,
});
```

Error messages and stacks are not PII-safe simply because the SDK accepts an
`Error`. Normalize expected errors before capture when their messages embed
input, URLs, SQL, tokens, or upstream payloads.

Logs should use stable human-readable messages plus structured attributes:

```ts
telemetry.log("warn", "payment provider degraded", {
  "payment.provider": "stripe",
  "http.response.status_code": 503,
});
```

Do not interpolate identifiers or bodies into the message. Structured data is
easier to filter, redact, and bound.

## Versioning an event contract

Add optional attributes without renaming a stable event. For a semantic change:

1. Introduce a new event name or explicit bounded `event.schema_version`.
2. Emit both only for a short, documented migration window.
3. Update dashboards/queries.
4. Remove the old producer and later the old query.

Changing what `checkout.completed` means in place makes historical comparisons
invalid. Record event ownership and meaning beside application code.

See [privacy and redaction](privacy.md) and [analytics recipes](analytics-recipes.md).
