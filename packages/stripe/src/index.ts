import type { Attributes, TelemetryClient } from "@davidilie/telemetry-core";

/** The small structural subset of `Stripe.Event` this package reads. */
export interface StripeWebhookEvent {
  readonly type: string;
  readonly livemode: boolean;
  readonly data: { readonly object: unknown };
}

/** The two core operations used to record normalized commerce telemetry. */
export type StripeTelemetryClient = Pick<TelemetryClient, "capture" | "measure">;

type EventFamily =
  | "checkout"
  | "payment"
  | "sale"
  | "refund"
  | "invoice"
  | "subscription"
  | "dispute";

interface EventMapping {
  readonly eventName: string;
  readonly family: EventFamily;
  readonly outcome: string;
  readonly amountField?: string;
  readonly measurementName?: string;
  readonly statusField?: string;
  readonly statuses?: readonly string[];
  /** Only these statuses make an event-specific amount safe to count. */
  readonly amountStatuses?: readonly string[];
}

const CHECKOUT_STATUSES = ["paid", "unpaid", "no_payment_required"] as const;
const PAYMENT_INTENT_STATUSES = [
  "canceled",
  "processing",
  "requires_action",
  "requires_capture",
  "requires_confirmation",
  "requires_payment_method",
  "succeeded",
] as const;
const CHARGE_STATUSES = ["failed", "pending", "succeeded"] as const;
const INVOICE_STATUSES = ["draft", "open", "paid", "uncollectible", "void"] as const;
const SUBSCRIPTION_STATUSES = [
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
] as const;
const DISPUTE_STATUSES = [
  "lost",
  "needs_response",
  "prevented",
  "under_review",
  "warning_closed",
  "warning_needs_response",
  "warning_under_review",
  "won",
] as const;

/** Every exported dimension comes from this finite mapping, never arbitrary input. */
const EVENT_MAPPINGS = {
  "checkout.session.completed": {
    eventName: "commerce.checkout.completed",
    family: "checkout",
    outcome: "completed",
    amountField: "amount_total",
    measurementName: "commerce.checkout.amount",
    statusField: "payment_status",
    statuses: CHECKOUT_STATUSES,
    amountStatuses: ["paid"],
  },
  "payment_intent.succeeded": {
    eventName: "commerce.payment.succeeded",
    family: "payment",
    outcome: "succeeded",
    amountField: "amount_received",
    measurementName: "commerce.payment.amount",
    statusField: "status",
    statuses: PAYMENT_INTENT_STATUSES,
  },
  "payment_intent.payment_failed": {
    eventName: "commerce.payment.failed",
    family: "payment",
    outcome: "failed",
    amountField: "amount",
    measurementName: "commerce.payment.amount",
    statusField: "status",
    statuses: PAYMENT_INTENT_STATUSES,
  },
  "charge.succeeded": {
    eventName: "commerce.sale.succeeded",
    family: "sale",
    outcome: "succeeded",
    amountField: "amount",
    measurementName: "commerce.sale.amount",
    statusField: "status",
    statuses: CHARGE_STATUSES,
  },
  "charge.failed": {
    eventName: "commerce.sale.failed",
    family: "sale",
    outcome: "failed",
    amountField: "amount",
    measurementName: "commerce.sale.amount",
    statusField: "status",
    statuses: CHARGE_STATUSES,
  },
  "charge.refunded": {
    eventName: "commerce.refund.completed",
    family: "refund",
    outcome: "completed",
  },
  "refund.created": {
    eventName: "commerce.refund.created",
    family: "refund",
    outcome: "created",
    amountField: "amount",
    measurementName: "commerce.refund.amount",
    statusField: "status",
    statuses: ["canceled", "failed", "pending", "requires_action", "succeeded"],
  },
  "invoice.paid": {
    eventName: "commerce.invoice.paid",
    family: "invoice",
    outcome: "paid",
    amountField: "amount_paid",
    measurementName: "commerce.invoice.amount",
    statusField: "status",
    statuses: INVOICE_STATUSES,
  },
  "invoice.payment_failed": {
    eventName: "commerce.invoice.payment_failed",
    family: "invoice",
    outcome: "failed",
    amountField: "amount_due",
    measurementName: "commerce.invoice.amount",
    statusField: "status",
    statuses: INVOICE_STATUSES,
  },
  "customer.subscription.created": {
    eventName: "commerce.subscription.started",
    family: "subscription",
    outcome: "started",
    statusField: "status",
    statuses: SUBSCRIPTION_STATUSES,
  },
  "customer.subscription.updated": {
    eventName: "commerce.subscription.changed",
    family: "subscription",
    outcome: "changed",
    statusField: "status",
    statuses: SUBSCRIPTION_STATUSES,
  },
  "customer.subscription.deleted": {
    eventName: "commerce.subscription.ended",
    family: "subscription",
    outcome: "ended",
    statusField: "status",
    statuses: SUBSCRIPTION_STATUSES,
  },
  "charge.dispute.created": {
    eventName: "commerce.dispute.opened",
    family: "dispute",
    outcome: "opened",
    amountField: "amount",
    measurementName: "commerce.dispute.amount",
    statusField: "status",
    statuses: DISPUTE_STATUSES,
  },
  "charge.dispute.closed": {
    eventName: "commerce.dispute.closed",
    family: "dispute",
    outcome: "closed",
    amountField: "amount",
    measurementName: "commerce.dispute.amount",
    statusField: "status",
    statuses: DISPUTE_STATUSES,
  },
} as const satisfies Record<string, EventMapping>;

export type SupportedStripeEventType = keyof typeof EVENT_MAPPINGS;
export type StripeCommerceEventName =
  (typeof EVENT_MAPPINGS)[SupportedStripeEventType]["eventName"];

export type StripeTelemetryResult =
  | { readonly recorded: true; readonly eventName: StripeCommerceEventName; readonly measured: boolean }
  | { readonly recorded: false; readonly reason: "invalid_event" | "unsupported_event" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return whether an event type is part of the bounded public mapping. */
export function isSupportedStripeEventType(value: string): value is SupportedStripeEventType {
  return Object.hasOwn(EVENT_MAPPINGS, value);
}

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return /^[a-z]{3}$/.test(normalized) ? normalized : undefined;
}

function readAllowedStatus(
  object: Record<string, unknown>,
  mapping: EventMapping,
): string | undefined {
  if (!mapping.statusField || !mapping.statuses) return undefined;
  const value = object[mapping.statusField];
  return typeof value === "string" && mapping.statuses.includes(value) ? value : undefined;
}

function readAmount(object: Record<string, unknown>, mapping: EventMapping): number | undefined {
  if (!mapping.amountField) return undefined;
  const value = object[mapping.amountField];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

interface PreparedSignal {
  readonly mapping: EventMapping;
  readonly attributes: Attributes;
  readonly amount?: number;
}

function prepareSignal(event: StripeWebhookEvent | null | undefined): PreparedSignal | undefined {
  try {
    if (!isRecord(event) || typeof event.type !== "string") return undefined;
    if (typeof event.livemode !== "boolean" || !isRecord(event.data)) return undefined;
    if (!isRecord(event.data.object) || !isSupportedStripeEventType(event.type)) return undefined;

    const mapping: EventMapping = EVENT_MAPPINGS[event.type];
    const object = event.data.object;
    const currency = normalizeCurrency(object.currency);
    const status = readAllowedStatus(object, mapping);
    const amount = readAmount(object, mapping);
    const statusAllowsAmount =
      !mapping.amountStatuses || (status !== undefined && mapping.amountStatuses.includes(status));
    const attributes: Attributes = {
      "commerce.provider": "stripe",
      "commerce.event.family": mapping.family,
      "stripe.event.type": event.type,
      "commerce.mode": event.livemode ? "live" : "test",
      "commerce.outcome": mapping.outcome,
      ...(currency ? { "commerce.currency": currency } : {}),
      ...(status ? { "commerce.status": status } : {}),
    };

    // Amounts without currency cannot be aggregated safely. Some lifecycle
    // events (notably Checkout completion) also need a payment-status guard.
    return {
      mapping,
      attributes,
      ...(amount !== undefined && currency && statusAllowsAmount ? { amount } : {}),
    };
  } catch {
    // Malformed objects and hostile getters must not affect webhook handling.
    return undefined;
  }
}

/**
 * Record one already signature-verified, caller-deduplicated Stripe webhook.
 *
 * Only bounded type/mode/status/currency values and one event-specific amount
 * are read. IDs, metadata, descriptions, messages, URLs, and raw payloads are
 * never passed to telemetry.
 */
export function recordStripeWebhookEvent(
  telemetry: StripeTelemetryClient,
  event: StripeWebhookEvent | null | undefined,
): StripeTelemetryResult {
  let type: string | undefined;
  try {
    type = event?.type;
  } catch {
    return { recorded: false, reason: "invalid_event" };
  }

  if (typeof type !== "string") return { recorded: false, reason: "invalid_event" };
  if (!isSupportedStripeEventType(type)) {
    return { recorded: false, reason: "unsupported_event" };
  }

  const prepared = prepareSignal(event);
  if (!prepared) return { recorded: false, reason: "invalid_event" };

  telemetry.capture(prepared.mapping.eventName, prepared.attributes);
  if (prepared.amount !== undefined && prepared.mapping.measurementName !== undefined) {
    telemetry.measure(
      prepared.mapping.measurementName,
      prepared.amount,
      prepared.attributes,
      "minor_currency_unit",
    );
    return {
      recorded: true,
      eventName: prepared.mapping.eventName as StripeCommerceEventName,
      measured: true,
    };
  }

  return {
    recorded: true,
    eventName: prepared.mapping.eventName as StripeCommerceEventName,
    measured: false,
  };
}
