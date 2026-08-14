import { afterEach, describe, expect, it, vi } from "vitest";
import { context, metrics, SpanKind, trace } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  SamplingDecision,
} from "@opentelemetry/sdk-trace-base";
import type { TelemetrySignal } from "@davidilie/telemetry-core";
import { createNodeTelemetry } from "./client.js";
import { OpenTelemetryAdapter } from "./adapter.js";
import { DynamicTelemetrySampler } from "./sampler.js";
import {
  telemetryResourceAttributes,
  toOtelAttributes,
} from "./attributes.js";

describe("Node telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("maps the shared resource contract to OpenTelemetry attributes", () => {
    expect(
      telemetryResourceAttributes({
        serviceName: "zerocut",
        serviceVersion: "abc123",
        environment: "production",
        namespace: "zerocut",
        repositoryUrl: "https://github.com/DavidIlie/zerocut",
        commitSha: "abc123",
        platform: "node",
        attributes: { cluster: "davidapps-cluster" },
      }),
    ).toMatchObject({
      "service.name": "zerocut",
      "service.version": "abc123",
      "deployment.environment.name": "production",
      "service.namespace": "zerocut",
      "vcs.ref.head.revision": "abc123",
      "app.platform": "node",
      cluster: "davidapps-cluster",
    });
  });

  it("copies readonly arrays into OpenTelemetry-compatible values", () => {
    const input = ["one", "two"] as const;
    const result = toOtelAttributes({ values: input });

    expect(result.values).toEqual(["one", "two"]);
    expect(result.values).not.toBe(input);
  });

  it("does not create a span when telemetry is disabled", async () => {
    const telemetry = createNodeTelemetry({
      resource: { serviceName: "test" },
      enabled: false,
    });

    await expect(telemetry.withSpan("disabled", () => 42)).resolves.toBe(42);
    expect(telemetry.currentTraceContext()).toBeUndefined();
  });

  it("rethrows errors from active span operations", async () => {
    const telemetry = createNodeTelemetry({
      resource: { serviceName: "test" },
    });

    await expect(
      telemetry.withSpan("failing-operation", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("writes structured logs for the Kubernetes stdout pipeline", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const telemetry = createNodeTelemetry({
      resource: {
        serviceName: "test-service",
        serviceVersion: "abc123",
      },
    });

    telemetry.log("info", "request complete", { "http.response.status_code": 200 });
    await telemetry.flush();

    const record = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      level: "info",
      message: "request complete",
      service_name: "test-service",
      service_version: "abc123",
      "http.response.status_code": 200,
    });
  });

  it("bounds metric instruments and exports only allowlisted labels", () => {
    const record = vi.fn();
    const createHistogram = vi.fn(() => ({ record }));
    vi.spyOn(metrics, "getMeter").mockReturnValue({ createHistogram } as never);
    const adapter = new OpenTelemetryAdapter({
      resource: { serviceName: "storefront" },
      measurementMode: "metrics",
      metricAttributeAllowlist: ["route"],
      maxMetricInstruments: 2,
      structuredConsole: false,
    });
    const base = {
      id: "unique-signal-id",
      timestamp: "2026-08-14T10:00:00.000Z",
      resource: {
        serviceName: "storefront",
        commitSha: "full-git-sha",
      },
      attributes: { route: "/checkout", session: "high-cardinality" },
      type: "measurement",
      value: 42,
    } as const;

    adapter.send({ ...base, name: "checkout.duration", unit: "ms" });
    adapter.send({ ...base, name: "checkout.items", unit: "item" });
    adapter.send({ ...base, name: "checkout.third", unit: "item" });
    adapter.send({ ...base, name: "invalid metric name", unit: "item" });

    expect(createHistogram).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(42, { route: "/checkout" });
    expect(JSON.stringify(record.mock.calls)).not.toContain("unique-signal-id");
    expect(JSON.stringify(record.mock.calls)).not.toContain("full-git-sha");
    expect(JSON.stringify(record.mock.calls)).not.toContain("high-cardinality");
  });

  it("ends synthetic signal spans at the capture timestamp", () => {
    const end = vi.fn();
    const addEvent = vi.fn();
    const startSpan = vi.fn(() => ({ addEvent, end }));
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(undefined);
    vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never);
    const adapter = new OpenTelemetryAdapter({
      resource: { serviceName: "storefront" },
      structuredConsole: false,
    });
    const signal: TelemetrySignal = {
      id: "event-1",
      timestamp: "2026-08-14T10:00:00.000Z",
      resource: { serviceName: "storefront" },
      attributes: {},
      type: "event",
      name: "checkout.completed",
    };

    adapter.send(signal);

    expect(startSpan).toHaveBeenCalledWith(
      "checkout.completed",
      expect.objectContaining({ startTime: new Date(signal.timestamp) }),
    );
    expect(end).toHaveBeenCalledWith(new Date(signal.timestamp));
  });

  it("prevents span attributes from overriding resource identity", () => {
    const startSpan = vi.fn(() => ({
      end: vi.fn(),
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
    }));
    vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never);
    const adapter = new OpenTelemetryAdapter({
      resource: {
        serviceName: "trusted-service",
        commitSha: "trusted-revision",
        attributes: { "service.name": "resource-spoof" },
      },
    });

    adapter.startSpan("work", {
      "service.name": "signal-spoof",
      "vcs.ref.head.revision": "signal-spoof",
    });

    expect(startSpan).toHaveBeenCalledWith(
      "work",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "service.name": "trusted-service",
          "vcs.ref.head.revision": "trusted-revision",
        }),
      }),
    );
  });

  it("updates provider-wide sampling when consent or enabled state changes", () => {
    const sampler = new DynamicTelemetrySampler(new AlwaysOnSampler(), {
      enabled: true,
      consent: "pending",
    });
    const decide = () =>
      sampler.shouldSample(
        context.active(),
        "0123456789abcdef0123456789abcdef",
        "request",
        SpanKind.SERVER,
        {},
        [],
      ).decision;

    expect(decide()).toBe(SamplingDecision.NOT_RECORD);
    sampler.setConsent("granted");
    expect(decide()).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    sampler.setEnabled(false);
    expect(decide()).toBe(SamplingDecision.NOT_RECORD);
  });
});
