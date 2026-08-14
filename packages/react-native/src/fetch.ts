// SPDX-License-Identifier: Apache-2.0

import type { TelemetryClient, TelemetrySpan, TraceContext } from "@davidapps/telemetry-core";

export type UrlMatcher = string | RegExp;

export interface FetchInstrumentationOptions {
  /** OTLP endpoint whose entire origin must never instrument itself. */
  ingestEndpoint: string;
  excludeUrls?: readonly UrlMatcher[];
  /** Explicit allowlist for W3C `traceparent` injection. Empty by default. */
  propagateTraceHeadersTo?: readonly UrlMatcher[];
}

interface SpanWithTraceContext extends TelemetrySpan {
  traceContext(): TraceContext | undefined;
}

const PATCH_MARKER = Symbol.for("@davidapps/telemetry-react-native.fetch");

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function safeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.split(/[?#]/, 1)[0] ?? "";
  }
}

function matches(rawUrl: string, matcher: UrlMatcher): boolean {
  if (typeof matcher === "string") return rawUrl.startsWith(matcher);
  matcher.lastIndex = 0;
  return matcher.test(rawUrl);
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function isIngestRequest(rawUrl: string, endpoint: string): boolean {
  try {
    return new URL(rawUrl).origin === endpointOrigin(endpoint);
  } catch {
    return rawUrl.startsWith(endpointOrigin(endpoint));
  }
}

function hasTraceContext(span: TelemetrySpan): span is SpanWithTraceContext {
  return "traceContext" in span && typeof span.traceContext === "function";
}

function traceparent(context: TraceContext): string {
  const flags = (context.traceFlags ?? 1) & 0xff;
  return `00-${context.traceId}-${context.spanId}-${flags.toString(16).padStart(2, "0")}`;
}

function injectHeaders(input: RequestInfo | URL, init: RequestInit | undefined, value: string): RequestInit {
  const inputHeaders =
    typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(init?.headers ?? inputHeaders);
  if (!headers.has("traceparent")) headers.set("traceparent", value);
  return { ...init, headers };
}

export function installFetchInstrumentation(
  client: TelemetryClient,
  options: FetchInstrumentationOptions,
): () => void {
  if (typeof globalThis.fetch !== "function") return () => {};

  const current = globalThis.fetch as typeof globalThis.fetch & { [PATCH_MARKER]?: true };
  if (current[PATCH_MARKER]) return () => {};

  const original = globalThis.fetch;
  const wrapped: typeof globalThis.fetch & { [PATCH_MARKER]?: true } = async (input, init) => {
    const rawUrl = requestUrl(input);
    if (
      isIngestRequest(rawUrl, options.ingestEndpoint) ||
      options.excludeUrls?.some((matcher) => matches(rawUrl, matcher))
    ) {
      return original.call(globalThis, input, init);
    }

    const method = requestMethod(input, init);
    const span = client.startSpan(`HTTP ${method}`, {
      "http.request.method": method,
      "url.full": safeUrl(rawUrl),
    });
    let requestInit = init;

    if (
      options.propagateTraceHeadersTo?.some((matcher) => matches(rawUrl, matcher)) &&
      hasTraceContext(span)
    ) {
      const context = span.traceContext();
      if (context) requestInit = injectHeaders(input, init, traceparent(context));
    }

    try {
      const response = await original.call(globalThis, input, requestInit);
      span.setAttribute("http.response.status_code", response.status);
      if (response.status >= 400) {
        span.setAttribute("error.type", String(response.status));
      }
      return response;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  };
  wrapped[PATCH_MARKER] = true;
  globalThis.fetch = wrapped;

  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}
