import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "./index.js";

const config = {
  projects: [
    {
      id: "test",
      hosts: ["e.example.com"],
      allowedOrigins: ["https://example.com"],
      publicKey: "public-test",
      allowFaro: true,
      allowTraces: true,
    },
  ],
  faroUpstream: "http://alloy:12347",
  otlpUpstream: "http://alloy:4318",
  maxBodyBytes: 1024,
  upstreamTimeoutMs: 1000,
} as const;

const apps: ReturnType<typeof createGateway>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("telemetry gateway", () => {
  it("routes an allowed Faro payload", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const app = createGateway(config, fetchMock);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/collect",
      headers: {
        host: "e.example.com",
        origin: "https://example.com",
        "x-api-key": "public-test",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ meta: { app: { name: "test" } }, events: [] }),
    });

    expect(response.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://alloy:12347/collect");
  });

  it("rejects an unknown origin", async () => {
    const fetchMock = vi.fn();
    const app = createGateway(config, fetchMock);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/collect",
      headers: {
        host: "e.example.com",
        origin: "https://attacker.example",
        "x-api-key": "public-test",
      },
      payload: "{}",
    });

    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose OTLP logs unless enabled", async () => {
    const app = createGateway(config, vi.fn());
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/logs",
      headers: { host: "e.example.com", "x-api-key": "public-test" },
      payload: Buffer.from([]),
    });
    expect(response.statusCode).toBe(404);
  });
});
