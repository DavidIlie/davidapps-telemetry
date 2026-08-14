# Privacy and redaction

Telemetry is a data pipeline. Treat every emitted value as something that can
be retained, searched, copied into a dashboard, and shown to an agent. The SDK's
sanitizer is a last defensive layer, not a privacy policy or DLP system.

## Data that must not be captured

- Authorization headers, cookies, passwords, tokens, API keys, and secrets
- Request/response bodies or arbitrary headers
- Email addresses, phone numbers, names, postal addresses, or form contents
- Raw database/user/account/device IDs
- Full URLs containing queries/fragments or concrete sensitive path segments
- Payment/card data, health data, private messages, uploaded file contents
- SQL statements, upstream payloads, or error messages known to embed inputs

Capture a stable classification instead:

```ts
telemetry.captureException(normalizePublicError(error), {
  "checkout.stage": "payment",
  "payment.provider": "stripe",
  "http.response.status_code": 503,
});
```

## What core sanitization actually does

`sanitizeAttributes` removes an attribute when its key matches a broad pattern
for authorization, cookies/headers/bodies, passwords, secrets, credential
tokens/API keys, email/phone/IP, or direct user/account/customer identifiers.
It also prevents ordinary attributes from replacing reserved
service/deployment/VCS resource identity and applies:

| Limit | Value |
| --- | --- |
| Attributes per object | 64 |
| Key length | 128 characters |
| String value length | 2,048 characters |
| Array length | 32 primitive entries |
| Event/span/resource name | 256 characters |
| Exception stack length | 16,384 characters |

String values, error messages, stacks, causes, log messages, names, and resource
metadata receive best-effort text redaction. URLs lose credentials/query/hash;
Bearer/Basic credentials, assigned token/password/secret values, JWT-shaped
strings, and email addresses become redaction markers.

This is pattern matching, not semantic PII detection. A phone number, private
name, record ID, or free text can survive under a harmless-looking allowed key.
Sanitize URLs at collection time and use route templates even though URL-keyed
values and URLs embedded in text are scrubbed. The React Native fetch helper
also strips query/fragment before creating `url.full`.

## Trusted configuration and hooks

Resource configuration is application/build input. Core copies and sanitizes it
when creating a client, and bundled adapters map that sanitized identity into
their protocol. Still put only stable public deployment metadata in it:

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

`beforeSend` receives a core-sanitized signal and its return value is sanitized
again. `beforeSendFaro` handles raw Faro items, including automatic browser
telemetry, outside that core pass. Hooks and additional upstream
instrumentations remain trusted extension code; prevention at collection time
is stronger than relying on a final scrubber.

A conservative hook can remove project-specific fields:

```ts
beforeSend: (signal) => {
  const { "search.query": _query, ...attributes } = signal.attributes;
  return { ...signal, attributes };
},
```

Prefer preventing collection over redacting after a value has entered another
SDK's internal queue.

Low-level adapter instances and Node's provider-level `startSpan`, `withSpan`,
and `recordException` helpers do not run the full core signal pipeline. The
Node helpers apply direct bounds/redaction, but bypass client context,
`beforeSend`, and per-call consent/sampling; only provider policy applies. They
are integration primitives, not a shortcut around the initialized application
client.

## URLs and routes

- Capture origin plus normalized route template where possible.
- Remove query strings and fragments before calling the SDK.
- Replace record IDs/slugs with template segments.
- Treat pathname segments as potentially sensitive even without a query.
- Keep `tracePropagationTargets` and mobile propagation allowlists exact and
  narrow; trace headers should not be sent to arbitrary third parties.

```ts
// Good
{ "url.route": "/orders/:orderId" }

// Bad
{ "url.full": "https://example.com/orders/private-id?email=..." }
```

## Identity and consent

The SDK has no built-in user profile or `identify` API. Faro session IDs are
ephemeral operational correlation, not consent or identity.

If an application adds a pseudonymous subject key:

1. Document the question and lawful/policy basis.
2. Derive it server-side with a purpose-specific salt; do not send a raw ID.
3. Set a rotation and deletion period consistent with the query window.
4. Keep it out of Prometheus labels, Tempo span-metric dimensions, event names,
   and logs shown by default.
5. Do not reuse security/audit identifiers as analytics identity.

`consent: "pending"` and `"denied"` drop new core signals; there is no pending
queue. Revocation also drops accepted work still waiting in an asynchronous
`beforeSend` hook, but cannot recall adapter/backend data. On web, Faro
automatic collection has a separate pause state, so change consent through the
returned `WebTelemetry.setConsent(...)` method; it updates both layers. Calling
the nested core client directly affects custom calls only.

React Native's runtime synchronizes core consent with a mutable provider-wide
sampler. When `registerGlobal: true`, new third-party OpenTelemetry spans are
covered too, including children of sampled parents. This still cannot recall a
span already queued or exported.

Consent does not recall data already exported. Deletion and retention are
backend/operator responsibilities.

## Public client trust

The routing hostname, `publicKey`, resource fields, and payload are visible and
modifiable by browser/mobile users. The gateway does not authenticate an actor
or rewrite payload identity. Client telemetry cannot be the sole evidence for:

- Authorization or security audit decisions
- Billing or entitlements
- Fraud enforcement
- Compliance records
- A trusted count of unique people

Record authoritative business/security facts in a protected server-side
system. Telemetry is for diagnosis and aggregate observation.

## Review checklist

Before adding a signal:

- Can the event name grow with user/application data?
- Can any value contain a secret, direct identifier, free text, URL, body, or
  stack produced by an upstream system?
- Is the producer trusted server code or a forgeable client?
- Does the signal require optional consent?
- Is every dashboard grouping bounded?
- Are sampling and retention compatible with the claim the query will make?
- Is the exact deployed SHA attached without exposing a credential?
- Can an agent safely quote the resulting fields in a report?

When uncertain, emit less and add a reviewed field later.
