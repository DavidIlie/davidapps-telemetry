import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryClient } from "./client.js";
import type { TelemetrySignal } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("drops magic object keys instead of mutating the result prototype", async () => {
    const sent: TelemetrySignal[] = [];
    const telemetry = createTelemetryClient({
      adapter: { send: (signal) => void sent.push(signal) },
      resource: { serviceName: "test" },
    });

    telemetry.capture("prototype.keys", {
      "__proto__": ["polluted"],
      constructor: "shadowed",
      prototype: "shadowed",
      safe: "kept",
    } as Record<string, string | string[]>);
    await telemetry.flush();

    expect(sent).toHaveLength(1);
    const attributes = sent[0]!.attributes;
    expect(attributes).toEqual({ safe: "kept" });
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(Object.prototype.constructor).toBe(Object);
  });

  it("records and rethrows errors from withSpan", async () => {
    const recordException = vi.fn();
    const end = vi.fn();
    const telemetry = createTelemetryClient({
      adapter: {
        send: vi.fn(),
        startSpan: () => ({
          setAttribute() { return this; },
          recordException,
          setStatus() { return this; },
          end,
        }),
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

  it("keeps useful token counts while removing identities and every URL query", async () => {
    const sent: TelemetrySignal[] = [];
    const telemetry = createTelemetryClient({
      adapter: { send: (signal) => void sent.push(signal) },
      resource: {
        serviceName: "safe-service",
        repositoryUrl: "https://user:password@example.com/repo?token=secret#fragment",
        attributes: {
          authorization: "Bearer resource-secret",
          "service.name": "spoofed",
          "davidapps.project.id": "safe-project",
        },
      },
    });

    telemetry.capture("llm.completed", {
      input_tokens: 42,
      output_tokens: 21,
      "user.id": "direct-person",
      "url.full": "https://example.com/path?code=secret#fragment",
      links: ["https://example.com/a?secret=1", "https://example.com/b#private"],
    });
    await telemetry.flush();

    expect(sent[0]).toMatchObject({
      resource: {
        serviceName: "safe-service",
        repositoryUrl: "https://example.com/repo",
        attributes: { "davidapps.project.id": "safe-project" },
      },
      attributes: {
        input_tokens: 42,
        output_tokens: 21,
        "url.full": "https://example.com/path",
        links: ["https://example.com/a", "https://example.com/b"],
      },
    });
    expect(JSON.stringify(sent)).not.toContain("direct-person");
    expect(JSON.stringify(sent)).not.toContain("resource-secret");
    expect(JSON.stringify(sent)).not.toContain("spoofed");
  });

  it("re-sanitizes beforeSend output and contains synchronous hook failures", async () => {
    const send = vi.fn();
    const onError = vi.fn();
    const unsafe = createTelemetryClient({
      adapter: { send },
      resource: { serviceName: "test" },
      beforeSend: () => {
        throw new Error("hook broke");
      },
      onError,
    });

    expect(() => unsafe.capture("safe.event")).not.toThrow();
    await unsafe.flush();
    expect(send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "hook broke" }),
      expect.objectContaining({ operation: "beforeSend" }),
    );

    const sent: TelemetrySignal[] = [];
    const transformed = createTelemetryClient({
      adapter: { send: (signal) => void sent.push(signal) },
      resource: { serviceName: "test" },
      beforeSend: (signal) => ({
        ...signal,
        attributes: {
          ...signal.attributes,
          authorization: "Bearer reintroduced",
          "url.full": "https://example.com/?token=again",
        },
      }),
    });
    transformed.capture("safe.event");
    await transformed.flush();
    expect(sent[0]?.attributes).toEqual({ "url.full": "https://example.com/" });
  });

  it("treats a zero sample rate as absolute even when Math.random returns zero", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const send = vi.fn();
    const telemetry = createTelemetryClient({
      adapter: { send },
      resource: { serviceName: "test" },
      sampleRate: 0,
    });

    telemetry.capture("never");
    telemetry.startSpan("never").end();
    await telemetry.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("sanitizes span mutations and never lets adapter span failures break work", async () => {
    const setAttribute = vi.fn();
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const onError = vi.fn();
    const telemetry = createTelemetryClient({
      adapter: {
        send() {},
        startSpan: () => ({
          setAttribute(name, value) {
            setAttribute(name, value);
            return this;
          },
          recordException,
          setStatus(status, message) {
            setStatus(status, message);
            return this;
          },
          end,
        }),
      },
      resource: { serviceName: "test" },
      onError,
    });

    const span = telemetry.startSpan("checkout", {
      authorization: "secret",
      "url.full": "https://example.com/pay?token=secret",
    });
    span.setAttribute("response_body", "secret");
    span.setAttribute("url.full", "https://example.com/done?token=secret");
    span.recordException(new Error("Bearer very-secret at user@example.com"), {
      password: "secret",
    });
    span.setStatus("error", "token=secret user@example.com");
    span.end();
    span.end();

    expect(setAttribute).toHaveBeenCalledOnce();
    expect(setAttribute).toHaveBeenCalledWith("url.full", "https://example.com/done");
    expect(recordException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Bearer [REDACTED] at [REDACTED_EMAIL]" }),
      {},
    );
    expect(setStatus).toHaveBeenCalledWith("error", "token=[REDACTED] [REDACTED_EMAIL]");
    expect(end).toHaveBeenCalledOnce();

    const broken = createTelemetryClient({
      adapter: {
        send() {},
        startSpan() {
          throw new Error("adapter failed");
        },
      },
      resource: { serviceName: "test" },
      onError,
    });
    await expect(broken.withSpan("still-runs", () => "result")).resolves.toBe("result");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "adapter failed" }),
      expect.objectContaining({ operation: "startSpan" }),
    );
  });

  it("revokes queued async signals and shuts an adapter down only once", async () => {
    let release!: (signal: TelemetrySignal) => void;
    const send = vi.fn();
    const shutdown = vi.fn(async () => {});
    const telemetry = createTelemetryClient({
      adapter: { send, shutdown },
      resource: { serviceName: "test" },
      beforeSend: (signal) =>
        new Promise<TelemetrySignal>((resolve) => {
          release = resolve;
        }),
    });

    telemetry.capture("queued");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    telemetry.setConsent("denied");
    release({
      id: "release",
      timestamp: new Date().toISOString(),
      resource: { serviceName: "test" },
      attributes: {},
      type: "event",
      name: "queued",
    });
    await telemetry.flush();
    expect(send).not.toHaveBeenCalled();

    await Promise.all([telemetry.shutdown(), telemetry.shutdown()]);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("drains accepted async signals before shutdown and rejects new ones", async () => {
    let release!: (signal: TelemetrySignal) => void;
    const order: string[] = [];
    const send = vi.fn(async () => {
      order.push("send");
    });
    const adapterShutdown = vi.fn(async () => {
      order.push("shutdown");
    });
    const telemetry = createTelemetryClient({
      adapter: { send, shutdown: adapterShutdown },
      resource: { serviceName: "test" },
      beforeSend: (signal) =>
        new Promise<TelemetrySignal>((resolve) => {
          release = resolve;
        }),
    });

    telemetry.capture("accepted");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = telemetry.shutdown();
    telemetry.capture("too-late");
    release({
      id: "accepted",
      timestamp: new Date().toISOString(),
      resource: { serviceName: "test" },
      attributes: {},
      type: "event",
      name: "accepted",
    });
    await stopping;

    expect(send).toHaveBeenCalledOnce();
    expect(adapterShutdown).toHaveBeenCalledOnce();
    expect(order).toEqual(["send", "shutdown"]);
  });

  it("reports adapter rejection as send rather than beforeSend", async () => {
    const failure = new Error("transport rejected");
    const onError = vi.fn();
    const telemetry = createTelemetryClient({
      adapter: { send: async () => Promise.reject(failure) },
      resource: { serviceName: "test" },
      beforeSend: (signal) => signal,
      onError,
    });

    telemetry.capture("event");
    await telemetry.flush();
    expect(onError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ operation: "send" }),
    );
  });
});
