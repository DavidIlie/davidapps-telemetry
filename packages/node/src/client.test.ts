import { describe, expect, it, vi } from "vitest";
import { createNodeTelemetry } from "./client.js";
import {
  telemetryResourceAttributes,
  toOtelAttributes,
} from "./attributes.js";

describe("Node telemetry", () => {
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
    info.mockRestore();
  });
});
