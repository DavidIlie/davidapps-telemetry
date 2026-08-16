import { describe, expect, it, vi } from "vitest";
import {
  isSupportedStripeEventType,
  recordStripeWebhookEvent,
  type StripeTelemetryClient,
  type StripeWebhookEvent,
} from "./index.js";

function recorder() {
  return {
    capture: vi.fn<StripeTelemetryClient["capture"]>(),
    measure: vi.fn<StripeTelemetryClient["measure"]>(),
  };
}

function webhook(
  type: string,
  object: Record<string, unknown>,
  livemode = true,
): StripeWebhookEvent {
  return { type, livemode, data: { object } };
}

describe("recordStripeWebhookEvent", () => {
  it("records one payment event and one integer minor-unit measurement", () => {
    const telemetry = recorder();
    const result = recordStripeWebhookEvent(
      telemetry,
      webhook("payment_intent.succeeded", {
        id: "pi_private",
        customer: "cus_private",
        amount_received: 12_345,
        currency: "EUR",
        status: "succeeded",
        metadata: { order: "private" },
      }),
    );

    expect(result).toEqual({
      recorded: true,
      eventName: "commerce.payment.succeeded",
      measured: true,
    });
    expect(telemetry.capture).toHaveBeenCalledWith("commerce.payment.succeeded", {
      "commerce.provider": "stripe",
      "commerce.event.family": "payment",
      "stripe.event.type": "payment_intent.succeeded",
      "commerce.mode": "live",
      "commerce.outcome": "succeeded",
      "commerce.currency": "eur",
      "commerce.status": "succeeded",
    });
    expect(telemetry.measure).toHaveBeenCalledWith(
      "commerce.payment.amount",
      12_345,
      expect.objectContaining({ "commerce.currency": "eur" }),
      "minor_currency_unit",
    );
  });

  it.each([
    ["charge.succeeded", "commerce.sale.succeeded", "commerce.sale.amount", "amount"],
    ["refund.created", "commerce.refund.created", "commerce.refund.amount", "amount"],
    ["invoice.paid", "commerce.invoice.paid", "commerce.invoice.amount", "amount_paid"],
    ["charge.dispute.created", "commerce.dispute.opened", "commerce.dispute.amount", "amount"],
  ])("keeps %s in its own event and measurement family", (
    type,
    eventName,
    measurementName,
    amountField,
  ) => {
    const telemetry = recorder();
    const result = recordStripeWebhookEvent(
      telemetry,
      webhook(type, { [amountField]: 500, currency: "usd" }),
    );

    expect(result).toMatchObject({ recorded: true, eventName, measured: true });
    expect(telemetry.capture).toHaveBeenCalledTimes(1);
    expect(telemetry.measure).toHaveBeenCalledWith(
      measurementName,
      500,
      expect.objectContaining({ "commerce.currency": "usd" }),
      "minor_currency_unit",
    );
  });

  it("keeps charge.refunded lifecycle-only because amount_refunded is cumulative", () => {
    const telemetry = recorder();
    const result = recordStripeWebhookEvent(
      telemetry,
      webhook("charge.refunded", {
        amount_refunded: 1_500,
        currency: "usd",
      }),
    );

    expect(result).toEqual({
      recorded: true,
      eventName: "commerce.refund.completed",
      measured: false,
    });
    expect(telemetry.capture).toHaveBeenCalledTimes(1);
    expect(telemetry.measure).not.toHaveBeenCalled();
  });

  it("does not treat an unpaid completed Checkout Session as a paid amount", () => {
    for (const paymentStatus of ["unpaid", "no_payment_required", undefined]) {
      const telemetry = recorder();
      const result = recordStripeWebhookEvent(
        telemetry,
        webhook("checkout.session.completed", {
          amount_total: 4_200,
          currency: "usd",
          payment_status: paymentStatus,
        }),
      );

      expect(result).toEqual({
        recorded: true,
        eventName: "commerce.checkout.completed",
        measured: false,
      });
      expect(telemetry.capture).toHaveBeenCalledTimes(1);
      expect(telemetry.measure).not.toHaveBeenCalled();
    }
  });

  it("measures a completed Checkout Session only when payment_status is paid", () => {
    const telemetry = recorder();
    const result = recordStripeWebhookEvent(
      telemetry,
      webhook("checkout.session.completed", {
        amount_total: 4_200,
        currency: "usd",
        payment_status: "paid",
      }),
    );

    expect(result).toMatchObject({ recorded: true, measured: true });
    expect(telemetry.measure).toHaveBeenCalledWith(
      "commerce.checkout.amount",
      4_200,
      expect.objectContaining({ "commerce.status": "paid" }),
      "minor_currency_unit",
    );
  });

  it.each([
    ["customer.subscription.created", "commerce.subscription.started", "active"],
    ["customer.subscription.updated", "commerce.subscription.changed", "past_due"],
    ["customer.subscription.deleted", "commerce.subscription.ended", "canceled"],
  ])("records %s without inventing a subscription amount", (type, eventName, status) => {
    const telemetry = recorder();

    expect(recordStripeWebhookEvent(telemetry, webhook(type, { status }, false))).toEqual({
      recorded: true,
      eventName,
      measured: false,
    });
    expect(telemetry.capture).toHaveBeenCalledWith(
      eventName,
      expect.objectContaining({ "commerce.mode": "test", "commerce.status": status }),
    );
    expect(telemetry.measure).not.toHaveBeenCalled();
  });

  it("never exports identifiers, email, metadata, messages, descriptions, or URLs", () => {
    const telemetry = recorder();
    const privateValues = [
      "evt_private",
      "pi_private",
      "cus_private",
      "person@example.com",
      "secret failure",
      "https://example.com/private?token=secret",
      "private order",
    ];
    const event = webhook("payment_intent.payment_failed", {
      id: privateValues[1],
      customer: privateValues[2],
      receipt_email: privateValues[3],
      last_payment_error: { message: privateValues[4] },
      receipt_url: privateValues[5],
      description: privateValues[6],
      metadata: { password: "secret" },
      amount: 900,
      currency: "gbp",
      status: "requires_payment_method",
    }) as StripeWebhookEvent & { id: string };
    event.id = privateValues[0]!;

    recordStripeWebhookEvent(telemetry, event);

    const exported = JSON.stringify([
      ...telemetry.capture.mock.calls,
      ...telemetry.measure.mock.calls,
    ]);
    for (const value of [...privateValues, "password"]) expect(exported).not.toContain(value);
  });

  it("returns an explicit no-op for unsupported events", () => {
    const telemetry = recorder();

    expect(recordStripeWebhookEvent(telemetry, webhook("customer.created", {}))).toEqual({
      recorded: false,
      reason: "unsupported_event",
    });
    expect(isSupportedStripeEventType("customer.created")).toBe(false);
    expect(telemetry.capture).not.toHaveBeenCalled();
    expect(telemetry.measure).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    {},
    { type: "invoice.paid", livemode: true },
    { type: "invoice.paid", livemode: "yes", data: { object: {} } },
    { type: "invoice.paid", livemode: true, data: { object: null } },
  ])("does not throw or emit for malformed input %#", (event) => {
    const telemetry = recorder();
    const record = () => recordStripeWebhookEvent(telemetry, event as never);

    expect(record).not.toThrow();
    expect(record()).toEqual({ recorded: false, reason: "invalid_event" });
    expect(telemetry.capture).not.toHaveBeenCalled();
    expect(telemetry.measure).not.toHaveBeenCalled();
  });

  it.each([
    { amount_paid: 1.5, currency: "usd" },
    { amount_paid: -1, currency: "usd" },
    { amount_paid: Number.POSITIVE_INFINITY, currency: "usd" },
    { amount_paid: 100, currency: "not-a-currency" },
    { amount_paid: 100 },
    { amount_paid: "100", currency: "usd" },
  ])("omits malformed or currencyless amounts without dropping the safe event", (object) => {
    const telemetry = recorder();
    const result = recordStripeWebhookEvent(telemetry, webhook("invoice.paid", object));

    expect(result).toEqual({
      recorded: true,
      eventName: "commerce.invoice.paid",
      measured: false,
    });
    expect(telemetry.capture).toHaveBeenCalledTimes(1);
    expect(telemetry.measure).not.toHaveBeenCalled();
  });

  it("omits arbitrary statuses instead of creating an unbounded dimension", () => {
    const telemetry = recorder();
    recordStripeWebhookEvent(
      telemetry,
      webhook("invoice.payment_failed", {
        amount_due: 100,
        currency: "usd",
        status: "user-controlled-status",
      }),
    );

    const attributes = telemetry.capture.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("commerce.status");
  });

  it("treats hostile getters as invalid instead of throwing", () => {
    const telemetry = recorder();
    const event = {
      get type(): string {
        throw new Error("getter failure");
      },
    };

    expect(recordStripeWebhookEvent(telemetry, event as never)).toEqual({
      recorded: false,
      reason: "invalid_event",
    });
  });
});
