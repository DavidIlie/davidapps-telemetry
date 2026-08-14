// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryClient,
  type Attributes,
  type TelemetryAdapter,
  type TelemetrySpan,
} from "@davidapps/telemetry-core";
import { installFetchInstrumentation } from "./fetch.js";

class TestSpan implements TelemetrySpan {
  readonly attributes: Record<string, unknown> = {};
  ended = false;

  setAttribute(name: string, value: string | number | boolean | readonly (string | number | boolean)[]): this {
    this.attributes[name] = value;
    return this;
  }

  recordException(): void {}

  traceContext() {
    return {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    };
  }

  end(): void {
    this.ended = true;
  }
}

describe("installFetchInstrumentation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("excludes the ingest origin and scrubs request query strings", async () => {
    const spans: Array<{ name: string; attributes: Attributes; span: TestSpan }> = [];
    const adapter: TelemetryAdapter = {
      send() {},
      startSpan(name, attributes = {}) {
        const span = new TestSpan();
        spans.push({ name, attributes, span });
        return span;
      },
    };
    const client = createTelemetryClient({ adapter, resource: { serviceName: "fixture" } });
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;

    const restore = installFetchInstrumentation(client, {
      ingestEndpoint: "https://secret-ingest.example/v1/traces",
    });
    await fetch("https://secret-ingest.example/v1/traces?recursive=true");
    await fetch("https://api.example/users?email=private@example.com", { method: "POST" });
    restore();

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("HTTP POST");
    expect(spans[0]?.attributes).toMatchObject({
      "http.request.method": "POST",
      "url.full": "https://api.example/users",
    });
    expect(spans[0]?.span.attributes).toMatchObject({ "http.response.status_code": 204 });
    expect(spans[0]?.span.ended).toBe(true);
  });

  it("only propagates to allowlisted origins and preserves Request headers", async () => {
    const adapter: TelemetryAdapter = {
      send() {},
      startSpan() {
        return new TestSpan();
      },
    };
    const client = createTelemetryClient({ adapter, resource: { serviceName: "fixture" } });
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init ?? {});
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const restore = installFetchInstrumentation(client, {
      ingestEndpoint: "https://ingest.example/v1/traces",
      propagateTraceHeadersTo: ["https://api.example/"],
    });

    const request = new Request("https://api.example/users", {
      headers: { "x-existing": "preserved" },
    });
    await fetch(request);
    restore();

    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("x-existing")).toBe("preserved");
    expect(headers.get("traceparent")).toBe(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
  });
});
