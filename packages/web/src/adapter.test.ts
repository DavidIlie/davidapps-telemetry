import { describe, expect, it, vi } from "vitest";
import type { Faro } from "@grafana/faro-web-sdk";
import type { TelemetrySignal } from "@davidilie/telemetry-core";
import { FaroTelemetryAdapter } from "./adapter.js";

function makeFaro() {
  const pushEvent = vi.fn();
  const pushError = vi.fn();
  const pushLog = vi.fn();
  const pushMeasurement = vi.fn();
  const getOTEL = vi.fn<Faro["api"]["getOTEL"]>(() => undefined);
  const getTraceContext = vi.fn<
    () => { trace_id: string; span_id: string } | undefined
  >(() => undefined);
  const pause = vi.fn();
  const faro = {
    api: {
      pushEvent,
      pushError,
      pushLog,
      pushMeasurement,
      getOTEL,
      getTraceContext,
    },
    pause,
  } as unknown as Faro;

  return {
    faro,
    getOTEL,
    getTraceContext,
    pause,
    pushError,
    pushEvent,
    pushLog,
    pushMeasurement,
  };
}

const base = {
  id: "signal-1",
  timestamp: "2026-08-14T10:00:00.000Z",
  resource: {
    serviceName: "storefront",
    serviceVersion: "1.2.3",
    commitSha: "abc123",
  },
  attributes: { route: "/checkout", duration: 42 },
} as const;

describe("FaroTelemetryAdapter", () => {
  it("maps core events to Faro and retains resource metadata", () => {
    const { faro, pushEvent } = makeFaro();
    const adapter = new FaroTelemetryAdapter(faro);
    const signal: TelemetrySignal = {
      ...base,
      type: "event",
      name: "checkout.completed",
    };

    adapter.send(signal);

    expect(pushEvent).toHaveBeenCalledWith(
      "checkout.completed",
      expect.objectContaining({
        route: "/checkout",
        duration: "42",
        "service.name": "storefront",
        "service.version": "1.2.3",
        "vcs.ref.head.revision": "abc123",
        "telemetry.signal.id": "signal-1",
      }),
      undefined,
      { timestampOverwriteMs: 1_786_701_600_000 },
    );
  });

  it("maps logs and measurements to their native Faro signals", () => {
    const { faro, pushLog, pushMeasurement } = makeFaro();
    const adapter = new FaroTelemetryAdapter(faro);

    adapter.send({ ...base, type: "log", level: "warn", message: "slow" });
    adapter.send({
      ...base,
      type: "measurement",
      name: "checkout.duration",
      value: 42,
      unit: "ms",
    });

    expect(pushLog).toHaveBeenCalledWith(
      ["slow"],
      expect.objectContaining({ level: "warn" }),
    );
    expect(pushMeasurement).toHaveBeenCalledWith(
      { type: "checkout.duration", values: { value: 42 } },
      expect.objectContaining({
        context: expect.objectContaining({ "measurement.unit": "ms" }),
      }),
    );
  });

  it("maps the active Faro trace context to the core shape", () => {
    const { faro, getTraceContext } = makeFaro();
    getTraceContext.mockReturnValue({ trace_id: "trace", span_id: "span" });

    expect(new FaroTelemetryAdapter(faro).currentTraceContext()).toEqual({
      traceId: "trace",
      spanId: "span",
    });
  });

  it("creates OpenTelemetry spans through Faro", () => {
    const { faro, getOTEL } = makeFaro();
    const setAttribute = vi.fn();
    const setAttributes = vi.fn();
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const startSpan = vi.fn(() => ({
      setAttribute,
      setAttributes,
      recordException,
      setStatus,
      end,
    }));
    getOTEL.mockReturnValue({
      trace: {
        getTracer: () => ({ startSpan }),
      },
      context: {},
    } as unknown as NonNullable<ReturnType<Faro["api"]["getOTEL"]>>);

    const span = new FaroTelemetryAdapter(faro).startSpan("checkout.create", {
      attempt: 2,
    });
    span.setAttribute("provider", "stripe");
    span.recordException(new Error("declined"), { retryable: false });
    span.setStatus("ok");
    span.end();

    expect(startSpan).toHaveBeenCalledWith("checkout.create", {
      kind: 0,
      attributes: { attempt: 2 },
    });
    expect(setAttribute).toHaveBeenCalledWith("provider", "stripe");
    expect(recordException).toHaveBeenCalledOnce();
    expect(setAttributes).toHaveBeenCalledWith({ retryable: false });
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ message: "declined" }),
    );
    expect(setStatus).toHaveBeenLastCalledWith({ code: 1 });
    expect(end).toHaveBeenCalledOnce();
  });
});
