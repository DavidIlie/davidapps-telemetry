import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BeforeSendHook } from "@grafana/faro-web-sdk";

const faro = vi.hoisted(() => ({
  api: {
    pushEvent: vi.fn(),
    pushError: vi.fn(),
    pushLog: vi.fn(),
    pushMeasurement: vi.fn(),
    getOTEL: vi.fn(() => undefined),
    getTraceContext: vi.fn(() => undefined),
  },
  pause: vi.fn(),
  unpause: vi.fn(),
}));
const initializeFaro = vi.hoisted(() => vi.fn(() => faro));
const getInternalFaroFromGlobalObject = vi.hoisted(() => vi.fn(() => undefined));
const getWebInstrumentations = vi.hoisted(() => vi.fn(() => [{ name: "web" }]));
const tracingOptions = vi.hoisted(() => vi.fn());

vi.mock("@grafana/faro-web-sdk", () => ({
  getInternalFaroFromGlobalObject,
  getWebInstrumentations,
  initializeFaro,
  LogLevel: {
    DEBUG: "debug",
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
  },
}));

vi.mock("@grafana/faro-web-tracing", () => ({
  TracingInstrumentation: class TracingInstrumentation {
    name = "tracing";
    constructor(options: unknown) {
      tracingOptions(options);
    }
  },
}));

describe("initializeWebTelemetry", () => {
  beforeEach(async () => {
    vi.stubGlobal("window", {});
    const { shutdownWebTelemetry } = await import("./initialize.js");
    await shutdownWebTelemetry();
    vi.clearAllMocks();
  });

  it("initializes Faro once with safe defaults and collector exclusion", async () => {
    const { initializeWebTelemetry } = await import("./initialize.js");
    const config = {
      url: "https://telemetry.example.com/collect/app",
      publicKey: "public-storefront",
      resource: {
        serviceName: "storefront",
        serviceVersion: "1.2.3",
        environment: "production",
        commitSha: "abc123",
      },
      tracePropagationTargets: [/^https:\/\/api\.example\.com/],
    };

    const first = initializeWebTelemetry(config);
    const second = initializeWebTelemetry(config);

    expect(first).toBe(second);
    expect(initializeFaro).toHaveBeenCalledOnce();
    expect(initializeFaro).toHaveBeenCalledWith(
      expect.objectContaining({
        url: config.url,
        apiKey: "public-storefront",
        app: expect.objectContaining({
          name: "storefront",
          version: "1.2.3",
          environment: "production",
          gitHash: "abc123",
        }),
        ignoreUrls: [config.url],
        paused: false,
      }),
    );
    expect(tracingOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceAttributes: expect.objectContaining({
          "service.name": "storefront",
          "vcs.ref.head.revision": "abc123",
        }),
        instrumentationOptions: {
          propagateTraceHeaderCorsUrls: config.tracePropagationTargets,
        },
      }),
    );
  });

  it("pauses automatic signals and installs the raw Faro before-send hook", async () => {
    const { initializeWebTelemetry } = await import("./initialize.js");
    const beforeSendFaro = vi.fn<BeforeSendHook>((item) => item);

    initializeWebTelemetry({
      url: "https://telemetry.example.com/collect/disabled",
      resource: { serviceName: "disabled-app" },
      enabled: false,
      beforeSendFaro,
      enableTracing: false,
      captureConsole: false,
    });

    expect(getWebInstrumentations).toHaveBeenCalledWith({
      captureConsole: false,
    });
    expect(initializeFaro).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeSend: beforeSendFaro,
        paused: true,
        instrumentations: [{ name: "web" }],
      }),
    );
  });
});
