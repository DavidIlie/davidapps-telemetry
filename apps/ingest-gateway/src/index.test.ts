import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./config.js";
import { createGateway } from "./index.js";

const config = {
  projects: [
    {
      id: "test",
      hosts: ["e.example.com"],
      allowedOrigins: ["https://example.com"],
      publicKey: "public-test",
      ratePerSecond: 100,
      burst: 100,
      allowFaro: true,
      allowTraces: true,
      allowLogs: false,
      allowMetrics: false,
    },
  ],
  faroUpstream: "http://alloy:12347",
  otlpUpstream: "http://alloy:4318",
  maxBodyBytes: 1_024,
  upstreamTimeoutMs: 1_000,
} as const satisfies GatewayConfig;

const apps: ReturnType<typeof createGateway>[] = [];

function gateway(
  fetchImplementation: typeof fetch = vi.fn(async () => new Response(null, { status: 202 })),
  overrides: Partial<GatewayConfig> = {},
) {
  const app = createGateway({ ...config, ...overrides }, fetchImplementation, { logger: false });
  apps.push(app);
  return app;
}

function signalHeaders(extra: Record<string, string> = {}) {
  return {
    host: "e.example.com",
    origin: "https://example.com",
    "x-api-key": "public-test",
    ...extra,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("telemetry gateway routing", () => {
  it("forwards Faro bytes and protocol headers and exposes the session response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
      expect(options?.redirect).toBe("error");
      expect(options?.body).toEqual(Buffer.from('{"events":[]}'));
      expect(options?.headers).toMatchObject({
        "content-type": "application/json",
        "x-davidapps-project": "test",
        "x-faro-session-id": "session-123",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        tracestate: "vendor=value",
        baggage: "safe=value",
      });
      return new Response(null, {
        status: 202,
        headers: { "x-faro-session-status": "invalid" },
      });
    });
    const app = gateway(fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/collect?source=browser",
      headers: signalHeaders({
        "content-type": "application/json",
        "x-faro-session-id": "session-123",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        tracestate: "vendor=value",
        baggage: "safe=value",
      }),
      payload: '{"events":[]}',
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["x-faro-session-status"]).toBe("invalid");
    expect(response.headers["access-control-allow-origin"]).toBe("https://example.com");
    expect(response.headers["access-control-expose-headers"]).toContain("x-faro-session-status");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://alloy:12347/collect");
  });

  it("preserves an OTLP partial-success body and content type byte for byte", async () => {
    const partialSuccess = Buffer.from([0x0a, 0x02, 0x08, 0x01]);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(partialSuccess, {
        status: 200,
        headers: { "content-type": "application/x-protobuf" },
      }),
    );
    const app = gateway(fetchMock);
    const requestBody = Buffer.from([0x0a, 0x00]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: signalHeaders({ "content-type": "application/x-protobuf" }),
      payload: requestBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-protobuf");
    expect(response.rawPayload).toEqual(partialSuccess);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toEqual(requestBody);
  });

  it("preserves upstream rejection status, Retry-After, and body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('{"error":"slow down"}', {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "17" },
      }),
    );
    const app = gateway(fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: signalHeaders({ "content-type": "application/json" }),
      payload: "{}",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.body).toBe('{"error":"slow down"}');
    expect(response.headers["access-control-allow-origin"]).toBe("https://example.com");
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain('route="traces",result="upstream_error"');
  });

  it("uses a 503 for an unavailable upstream and a 504 for a timeout", async () => {
    const unavailable = gateway(vi.fn<typeof fetch>(async () => Promise.reject(new Error("offline"))));
    const unavailableResponse = await unavailable.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders(),
      payload: "{}",
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json()).toEqual({ error: "upstream_unavailable" });

    const neverCompletes = vi.fn<typeof fetch>(async (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    const timedOut = gateway(neverCompletes, { upstreamTimeoutMs: 5 });
    const timeoutResponse = await timedOut.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders(),
      payload: "{}",
    });
    expect(timeoutResponse.statusCode).toBe(504);
    expect(timeoutResponse.json()).toEqual({ error: "upstream_timeout" });
  });
});

describe("telemetry gateway policy and CORS", () => {
  it("answers preflight only for a route enabled for that host", async () => {
    const app = gateway();
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/collect",
      headers: {
        host: "e.example.com",
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-api-key, x-faro-session-id",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-headers"]).toContain("x-faro-session-id");
    expect(allowed.headers["access-control-max-age"]).toBe("600");

    const disabled = await app.inject({
      method: "OPTIONS",
      url: "/v1/logs",
      headers: { host: "e.example.com", origin: "https://example.com" },
    });
    expect(disabled.statusCode).toBe(404);

    const unknown = await app.inject({
      method: "OPTIONS",
      url: "/not-an-ingest-route",
      headers: { host: "e.example.com", origin: "https://example.com" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("rejects unsupported preflight methods and headers", async () => {
    const app = gateway();
    const method = await app.inject({
      method: "OPTIONS",
      url: "/collect",
      headers: {
        host: "e.example.com",
        origin: "https://example.com",
        "access-control-request-method": "DELETE",
      },
    });
    expect(method.statusCode).toBe(405);
    expect(method.headers["access-control-allow-origin"]).toBe("https://example.com");

    const header = await app.inject({
      method: "OPTIONS",
      url: "/collect",
      headers: {
        host: "e.example.com",
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization",
      },
    });
    expect(header.statusCode).toBe(403);
  });

  it("adds CORS headers to policy, quota, upstream, and body-limit errors for an allowed origin", async () => {
    const invalidKeyApp = gateway();
    const invalidKey = await invalidKeyApp.inject({
      method: "POST",
      url: "/collect",
      headers: { host: "e.example.com", origin: "https://example.com" },
      payload: "{}",
    });
    expect(invalidKey.statusCode).toBe(401);
    expect(invalidKey.headers["access-control-allow-origin"]).toBe("https://example.com");

    const rateConfig: GatewayConfig = {
      ...config,
      projects: [{ ...config.projects[0], ratePerSecond: 0.001, burst: 1 }],
    };
    const limitedApp = gateway(undefined, rateConfig);
    await limitedApp.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders(),
      payload: "{}",
    });
    const limited = await limitedApp.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders(),
      payload: "{}",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("1");
    expect(limited.headers["access-control-allow-origin"]).toBe("https://example.com");

    const bodyLimitApp = gateway(undefined, { maxBodyBytes: 4 });
    const bodyLimit = await bodyLimitApp.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders({ "content-type": "text/plain" }),
      payload: "12345",
    });
    expect(bodyLimit.statusCode).toBe(413);
    expect(bodyLimit.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("does not grant CORS to an unlisted origin", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const app = gateway(fetchMock);
    const response = await app.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders({ origin: "https://attacker.example" }),
      payload: "{}",
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects wrong, missing, and length-variant keys without reaching the upstream", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const app = gateway(fetchMock);

    for (const key of [
      "public-tes", // one byte short
      "public-test-extra", // correct prefix, longer
      "Public-test", // case variant
      " public-test", // leading whitespace
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/collect",
        headers: signalHeaders({ "x-api-key": key }),
        payload: "{}",
      });
      expect(response.statusCode, key).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_key" });
    }

    const missing = await app.inject({
      method: "POST",
      url: "/collect",
      headers: { host: "e.example.com", origin: "https://example.com" },
      payload: "{}",
    });
    expect(missing.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders(),
      payload: "{}",
    });
    expect(valid.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("enforces explicit route permissions while retaining documented defaults", async () => {
    const { allowTraces: _allowTraces, ...projectWithoutTracePermission } = config.projects[0];
    const project = {
      ...projectWithoutTracePermission,
      allowFaro: false,
      allowLogs: true,
      allowMetrics: true,
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const app = gateway(fetchMock, { projects: [project] });

    for (const path of ["/v1/traces", "/v1/logs", "/v1/metrics"]) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: signalHeaders(),
        payload: Buffer.alloc(0),
      });
      expect(response.statusCode, path).toBe(200);
    }
    const faro = await app.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders(),
      payload: "{}",
    });
    expect(faro.statusCode).toBe(404);
    expect(faro.headers["access-control-allow-origin"]).toBe("https://example.com");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("records bounded outcomes on the internal Prometheus endpoint", async () => {
    const app = gateway();
    await app.inject({
      method: "POST",
      url: "/collect",
      headers: signalHeaders(),
      payload: "{}",
    });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("version=0.0.4");
    expect(metrics.body).toContain(
      'telemetry_gateway_requests_total{project="test",route="faro",result="accepted"} 1',
    );
  });

  it("logs a structured outcome without headers, identifiers, origins, or bodies", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const app = createGateway(config, vi.fn(), { logger: { level: "info", stream } });
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/collect",
      headers: {
        host: "e.example.com",
        origin: "https://example.com",
        "x-api-key": "wrong-secret-key",
        "x-faro-session-id": "private-session-id",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
      payload: '{"email":"private@example.com"}',
    });

    const entry = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === "telemetry gateway outcome");
    expect(entry).toMatchObject({
      telemetry: {
        project: "test",
        route: "faro",
        outcome: "invalid_key",
        status_code: 401,
      },
    });
    expect(output).not.toContain("wrong-secret-key");
    expect(output).not.toContain("private-session-id");
    expect(output).not.toContain("private@example.com");
    expect(output).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(output).not.toContain("https://example.com");
  });
});
