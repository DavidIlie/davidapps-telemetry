import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "./metrics.js";

describe("GatewayMetrics", () => {
  it("escapes untrusted Prometheus label text instead of injecting samples", () => {
    const metrics = new GatewayMetrics();
    metrics.increment('evil"\\\nmetric', "faro", "accepted");

    const rendered = metrics.render();
    expect(rendered).toContain('project="evil\\"\\\\\\nmetric"');
    expect(rendered).not.toContain("\nmetric\",route=");
    expect(rendered.match(/^telemetry_gateway_requests_total/mg)).toHaveLength(1);
  });
});
