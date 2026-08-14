import { describe, expect, it, vi } from "vitest";
import { createTelemetryClient } from "./client.js";
import type { TelemetrySignal } from "./types.js";

describe("TelemetryClient", () => {
  it("scrubs secrets and URL queries before sending", async () => {
    const sent: TelemetrySignal[] = [];
    const telemetry = createTelemetryClient({
      adapter: { send: (signal) => void sent.push(signal) },
      resource: { serviceName: "test" },
    });

    telemetry.capture("request.finished", {
      url: "https://example.com/path?token=secret#fragment",
      authorization: "Bearer secret",
      status: 200,
    });
    await telemetry.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.attributes).toEqual({
      url: "https://example.com/path",
      status: 200,
    });
  });

  it("can discard a signal in beforeSend", async () => {
    const send = vi.fn();
    const telemetry = createTelemetryClient({
      adapter: { send },
      resource: { serviceName: "test" },
      beforeSend: () => null,
    });

    telemetry.capture("discarded");
    await telemetry.flush();

    expect(send).not.toHaveBeenCalled();
  });

  it("records and rethrows errors from withSpan", async () => {
    const recordException = vi.fn();
    const end = vi.fn();
    const telemetry = createTelemetryClient({
      adapter: {
        send: vi.fn(),
        startSpan: () => ({ setAttribute() { return this; }, recordException, end }),
      },
      resource: { serviceName: "test" },
    });

    await expect(
      telemetry.withSpan("failure", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(recordException).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});

