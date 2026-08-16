# `@davidilie/telemetry-stripe`

A deliberately small Stripe webhook mapper for DavidApps telemetry. It turns a
strict allowlist of already verified Stripe webhook events into stable commerce
events and optional integer amount measurements. It does not make Stripe API
requests and has no dependency on the Stripe runtime SDK.

```bash
pnpm add @davidilie/telemetry-stripe @davidilie/telemetry-node stripe
```

## Use

Verify the signature using Stripe's SDK and the untouched raw request body,
then atomically claim the event ID in your own datastore before recording it:

```ts
import { recordStripeWebhookEvent } from "@davidilie/telemetry-stripe";

const event = stripe.webhooks.constructEvent(
  rawBody,
  request.headers.get("stripe-signature")!,
  process.env.STRIPE_WEBHOOK_SECRET!,
);

// Stripe retries deliveries. `claimWebhook` must return false for an event ID
// that this application has already processed.
if (await claimWebhook(event.id)) {
  recordStripeWebhookEvent(telemetry, event);
  await telemetry.flush();
}
```

`stripe` is an application dependency used for signature verification; this
package deliberately does not depend on or initialize it. `telemetry` is the
client already created by `@davidilie/telemetry-node` or
`@davidilie/telemetry-next`. `claimWebhook` is application-owned persistent
storage with a unique constraint or atomic set-if-absent operation—an in-memory
set does not deduplicate across replicas or restarts.

Read the request body exactly once as text or bytes. Parsing and reserializing
JSON before `constructEvent` changes the signed bytes and breaks verification.
Return a non-2xx response when verification or authoritative business handling
fails so Stripe can retry. Telemetry recording itself is intentionally
best-effort and must never decide whether an order, subscription, or refund
succeeded.

The returned result is explicit:

```ts
{ recorded: true, eventName: "commerce.payment.succeeded", measured: true }
{ recorded: false, reason: "unsupported_event" }
{ recorded: false, reason: "invalid_event" }
```

## Supported events

| Stripe webhook | Normalized event | Amount measurement |
| --- | --- | --- |
| `checkout.session.completed` | `commerce.checkout.completed` | `commerce.checkout.amount` when `payment_status` is `paid` |
| `payment_intent.succeeded` | `commerce.payment.succeeded` | `commerce.payment.amount` |
| `payment_intent.payment_failed` | `commerce.payment.failed` | `commerce.payment.amount` |
| `charge.succeeded` | `commerce.sale.succeeded` | `commerce.sale.amount` |
| `charge.failed` | `commerce.sale.failed` | `commerce.sale.amount` |
| `charge.refunded` | `commerce.refund.completed` | none; Stripe's `amount_refunded` is cumulative |
| `refund.created` | `commerce.refund.created` | `commerce.refund.amount` |
| `invoice.paid` | `commerce.invoice.paid` | `commerce.invoice.amount` |
| `invoice.payment_failed` | `commerce.invoice.payment_failed` | `commerce.invoice.amount` |
| `customer.subscription.created` | `commerce.subscription.started` | none |
| `customer.subscription.updated` | `commerce.subscription.changed` | none |
| `customer.subscription.deleted` | `commerce.subscription.ended` | none |
| `charge.dispute.created` | `commerce.dispute.opened` | `commerce.dispute.amount` |
| `charge.dispute.closed` | `commerce.dispute.closed` | `commerce.dispute.amount` |

Measurements use the fixed unit `minor_currency_unit`. For example, `1234` is
EUR 12.34 for a two-decimal currency. The mapper emits an amount only when it is
a non-negative safe integer and a three-letter currency is present. Dashboards
must group by `commerce.currency`; never sum different currencies together.

The Node adapter records measurements as spans by default. If the application
enables its OpenTelemetry histogram mode, explicitly allow only these bounded
metric attributes:

```ts
metricAttributeAllowlist: [
  "commerce.event.family",
  "stripe.event.type",
  "commerce.mode",
  "commerce.outcome",
  "commerce.currency",
  "commerce.status",
]
```

## Avoid double counting

Deduplicating Stripe event IDs prevents retry duplicates, but a single payment
can still produce a Checkout Session, PaymentIntent, Charge, and Invoice event.
Choose one canonical event family for each dashboard total. For example, use
`payment_intent.succeeded` for payment revenue, or `invoice.paid` for invoice
collections—do not sum both. Use `refund.created` as the canonical per-refund
amount. `charge.refunded` is lifecycle-only because its `amount_refunded` value
is cumulative and can otherwise overcount partial refunds.

This package is not a ledger. It does not reconcile missed events, calculate
MRR/LTV, convert currencies, or persist webhook delivery state.

## Grafana dashboard contract

For amount panels, configure the Node/Next client with OpenTelemetry histogram
measurements and the exact bounded allowlist shown above. A Prometheus-compatible
backend then exposes histogram count and sum series for the selected canonical
family. Use the increase of the `_sum` series over the dashboard range, grouped
by currency and mode; never combine currencies or add multiple payment families
together.

Keep these panels separate:

- successful payment amount from `payment_intent.succeeded`, or invoice amount
  from `invoice.paid`—choose one for revenue;
- refund amount from `refund.created`;
- dispute amount from `charge.dispute.created`;
- event counts and failures from the normalized `commerce.*` events/traces.

Confirm the exact metric and label names in Grafana Explore after the first
canary because the collector/backend controls OpenTelemetry-to-Prometheus name
normalization. The source measurement names and attributes in this package are
the stable contract.

## Privacy boundary

The mapper reads and exports only:

- a supported event type;
- live or test mode;
- a strictly allowlisted status;
- a valid three-letter currency; and
- one event-specific integer amount.

It never exports the raw payload, event/object/customer IDs, email, metadata,
descriptions, failure messages, URLs, or arbitrary Stripe fields. Unsupported
events are no-ops.
