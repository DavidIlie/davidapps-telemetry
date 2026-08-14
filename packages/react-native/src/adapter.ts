// SPDX-License-Identifier: Apache-2.0

import {
  SpanKind,
  SpanStatusCode,
  context,
  isSpanContextValid,
  trace,
  type Attributes as OtelAttributes,
  type AttributeValue as OtelAttributeValue,
  type Context as OtelContext,
  type Link,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import { StackContextManager, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import type {
  Attributes,
  AttributeValue,
  TelemetryAdapter,
  TelemetryResource,
  TelemetrySignal,
  TelemetrySpan,
  TelemetrySpanKind,
  TelemetrySpanOptions,
  TelemetrySpanStatus,
  TraceContext,
} from "@davidilie/telemetry-core";
import {
  redactText,
  sanitizeAttributes,
  sanitizeResource,
  sanitizeSignal,
} from "@davidilie/telemetry-core";

const PACKAGE_NAME = "@davidilie/telemetry-react-native";

export interface MobileBatchConfig {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
  exportTimeoutMillis?: number;
}

export interface OtlpReactNativeAdapterConfig {
  /** An OTLP base URL or a full `/v1/traces` endpoint. */
  endpoint: string;
  resource: TelemetryResource;
  headers?: Readonly<Record<string, string>>;
  batch?: MobileBatchConfig;
  sampleRate?: number;
  enabled?: boolean;
  consent?: "granted" | "denied" | "pending";
  /** Register this provider globally for interoperability with other OTel code. Disabled by default. */
  registerGlobal?: boolean;
}

export interface TraceableTelemetrySpan extends TelemetrySpan {
  traceContext(): TraceContext | undefined;
}

function clampSampleRate(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value ?? 1));
}

function toOtelValue(value: AttributeValue): OtelAttributeValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value.every((entry): entry is string => typeof entry === "string")) return [...value];
  if (value.every((entry): entry is number => typeof entry === "number")) return [...value];
  if (value.every((entry): entry is boolean => typeof entry === "boolean")) return [...value];
  // OTel requires homogeneous arrays; preserve mixed core values as strings
  // instead of silently deleting entries based on the first value's type.
  return value.map(String);
}

function toOtelAttributes(attributes: Attributes): OtelAttributes {
  const result: OtelAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null) result[key] = toOtelValue(value);
  }
  return result;
}

function resourceAttributes(resource: TelemetryResource) {
  return toOtelAttributes({
    ...resource.attributes,
    "service.name": resource.serviceName,
    ...(resource.serviceVersion ? { "service.version": resource.serviceVersion } : {}),
    ...(resource.environment ? { "deployment.environment.name": resource.environment } : {}),
    ...(resource.namespace ? { "service.namespace": resource.namespace } : {}),
    ...(resource.repositoryUrl
      ? {
          "app.repository.url": resource.repositoryUrl,
          "vcs.repository.url.full": resource.repositoryUrl,
        }
      : {}),
    ...(resource.commitSha ? { "vcs.ref.head.revision": resource.commitSha } : {}),
    ...(resource.platform
      ? {
          "mobile.platform": resource.platform,
          "deployment.platform": resource.platform,
        }
      : {}),
  });
}

const spanKinds: Record<TelemetrySpanKind, SpanKind> = {
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
};

const spanStatuses: Record<TelemetrySpanStatus, SpanStatusCode> = {
  unset: SpanStatusCode.UNSET,
  ok: SpanStatusCode.OK,
  error: SpanStatusCode.ERROR,
};

export class MobileCollectionSampler implements Sampler {
  #enabled: boolean;
  #consent: "granted" | "denied" | "pending";

  constructor(
    private readonly delegate: Sampler,
    enabled: boolean,
    consent: "granted" | "denied" | "pending",
  ) {
    this.#enabled = enabled;
    this.#consent = consent;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  setConsent(consent: "granted" | "denied" | "pending"): void {
    this.#consent = consent;
  }

  shouldSample(
    parentContext: OtelContext,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: OtelAttributes,
    links: Link[],
  ): SamplingResult {
    if (!this.#enabled || this.#consent !== "granted") {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.delegate.shouldSample(
      parentContext,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
  }

  toString(): string {
    return `MobileCollectionSampler{${this.delegate.toString()}}`;
  }
}

export function normalizeOtlpTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("A telemetry endpoint is required");

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Telemetry endpoint must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Telemetry endpoint must not contain credentials");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path || path === "/") parsed.pathname = "/v1/traces";
  else if (!path.endsWith("/v1/traces")) parsed.pathname = `${path}/v1/traces`;
  else parsed.pathname = path;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function signalName(signal: TelemetrySignal): string {
  switch (signal.type) {
    case "event":
      return signal.name;
    case "exception":
      return `exception.${signal.exception.name || "Error"}`;
    case "log":
      return `log.${signal.level}`;
    case "measurement":
      return `measurement.${signal.name}`;
  }
}

function spanContext(span: Span): TraceContext | undefined {
  const value = span.spanContext();
  if (!isSpanContextValid(value)) return undefined;
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags,
  };
}

class OtlpTelemetrySpan implements TraceableTelemetrySpan {
  constructor(private readonly span: Span) {}

  setAttribute(name: string, value: AttributeValue): this {
    const safe = sanitizeAttributes({ [name]: value });
    if (safe[name] !== undefined) this.span.setAttribute(name, toOtelValue(safe[name]));
    return this;
  }

  recordException(error: unknown, attributes: Attributes = {}): void {
    const original = error instanceof Error ? error : new Error(String(error));
    const safe = new Error(redactText(original.message), {
      ...(original.cause !== undefined
        ? { cause: redactText(String(original.cause)) }
        : {}),
    });
    safe.name = redactText(original.name, 256);
    if (original.stack) safe.stack = redactText(original.stack, 16_384);
    this.span.recordException(safe);
    this.span.setAttributes(toOtelAttributes(sanitizeAttributes(attributes)));
    this.span.setStatus({ code: SpanStatusCode.ERROR });
  }

  setStatus(status: TelemetrySpanStatus, message?: string): this {
    this.span.setStatus({
      code: spanStatuses[status],
      ...(message ? { message: redactText(message) } : {}),
    });
    return this;
  }

  traceContext(): TraceContext | undefined {
    return spanContext(this.span);
  }

  end(): void {
    this.span.end();
  }
}

class NoopTelemetrySpan implements TraceableTelemetrySpan {
  setAttribute(): this {
    return this;
  }

  recordException(): void {}
  setStatus(): this {
    return this;
  }
  traceContext(): undefined {
    return undefined;
  }
  end(): void {}
}

export class OtlpReactNativeAdapter implements TelemetryAdapter {
  readonly endpoint: string;
  readonly #provider: WebTracerProvider;
  readonly #tracer;
  readonly #sampler: MobileCollectionSampler;
  #shutdown = false;

  constructor(config: OtlpReactNativeAdapterConfig) {
    this.endpoint = normalizeOtlpTracesEndpoint(config.endpoint);
    const cleanResource = sanitizeResource(config.resource);
    const sampleRate = clampSampleRate(config.sampleRate);
    const exporter = new OTLPTraceExporter({
      url: this.endpoint,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
    });
    const maxQueueSize = Math.max(1, config.batch?.maxQueueSize ?? 512);
    const maxExportBatchSize = Math.min(
      maxQueueSize,
      Math.max(1, config.batch?.maxExportBatchSize ?? 64),
    );

    this.#sampler = new MobileCollectionSampler(
      new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRate) }),
      config.enabled ?? true,
      config.consent ?? "granted",
    );
    this.#provider = new WebTracerProvider({
      resource: resourceFromAttributes(resourceAttributes(cleanResource)),
      sampler: this.#sampler,
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxQueueSize,
          maxExportBatchSize,
          scheduledDelayMillis: Math.max(0, config.batch?.scheduledDelayMillis ?? 5_000),
          exportTimeoutMillis: Math.max(1, config.batch?.exportTimeoutMillis ?? 10_000),
        }),
      ],
    });

    if (config.registerGlobal ?? false) {
      this.#provider.register({ contextManager: new StackContextManager() });
    }
    this.#tracer = this.#provider.getTracer(PACKAGE_NAME);
  }

  send(signal: TelemetrySignal): void {
    if (this.#shutdown) return;
    signal = sanitizeSignal(signal);
    const startTime = new Date(signal.timestamp);
    const span = this.#tracer.startSpan(
      signalName(signal),
      {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: {
          ...toOtelAttributes(signal.attributes),
          "telemetry.signal.id": signal.id,
          "telemetry.signal.type": signal.type,
        },
      },
      context.active(),
    );

    switch (signal.type) {
      case "event":
        span.addEvent(signal.name, undefined, startTime);
        break;
      case "exception":
        span.recordException({
          name: signal.exception.name,
          message: signal.exception.message,
          ...(signal.exception.stack ? { stack: signal.exception.stack } : {}),
        });
        if (signal.exception.cause) span.setAttribute("exception.cause", signal.exception.cause);
        span.setStatus({ code: SpanStatusCode.ERROR, message: signal.exception.message });
        break;
      case "log":
        span.addEvent("log", {
          "log.severity": signal.level,
          "log.message": signal.message,
        }, startTime);
        if (signal.level === "error") span.setStatus({ code: SpanStatusCode.ERROR });
        break;
      case "measurement":
        span.setAttribute("measurement.name", signal.name);
        span.setAttribute("measurement.value", signal.value);
        if (signal.unit) span.setAttribute("measurement.unit", signal.unit);
        break;
    }
    span.end(startTime);
  }

  startSpan(
    name: string,
    attributes: Attributes = {},
    options: TelemetrySpanOptions = {},
  ): TraceableTelemetrySpan {
    if (this.#shutdown) return new NoopTelemetrySpan();
    const span = this.#tracer.startSpan(redactText(name, 256), {
      kind: spanKinds[options.kind ?? "internal"],
      attributes: toOtelAttributes(sanitizeAttributes(attributes)),
    });
    return new OtlpTelemetrySpan(span);
  }

  currentTraceContext(): TraceContext | undefined {
    const span = trace.getSpan(context.active());
    return span ? spanContext(span) : undefined;
  }

  setEnabled(enabled: boolean): void {
    this.#sampler.setEnabled(enabled);
  }

  setConsent(consent: "granted" | "denied" | "pending"): void {
    this.#sampler.setConsent(consent);
  }

  async flush(): Promise<void> {
    if (!this.#shutdown) await this.#provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    await this.#provider.shutdown();
  }
}
