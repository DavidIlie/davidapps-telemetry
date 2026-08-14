// SPDX-License-Identifier: Apache-2.0

import {
  SpanKind,
  SpanStatusCode,
  context,
  isSpanContextValid,
  trace,
  type Attributes as OtelAttributes,
  type AttributeValue as OtelAttributeValue,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { StackContextManager, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import type {
  Attributes,
  AttributeValue,
  TelemetryAdapter,
  TelemetryResource,
  TelemetrySignal,
  TelemetrySpan,
  TraceContext,
} from "@davidapps/telemetry-core";

const PACKAGE_NAME = "@davidapps/telemetry-react-native";

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
  /** Register this provider globally for interoperability with other OTel code. Disabled by default. */
  registerGlobal?: boolean;
}

export interface TraceableTelemetrySpan extends TelemetrySpan {
  traceContext(): TraceContext | undefined;
}

function clampSampleRate(value: number | undefined): number {
  return Math.min(1, Math.max(0, value ?? 1));
}

function toOtelValue(value: AttributeValue): OtelAttributeValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  const first = value[0];
  if (typeof first === "number") return value.filter((entry): entry is number => typeof entry === "number");
  if (typeof first === "boolean") return value.filter((entry): entry is boolean => typeof entry === "boolean");
  return value.filter((entry): entry is string => typeof entry === "string");
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
    ...(resource.repositoryUrl ? { "app.repository.url": resource.repositoryUrl } : {}),
    ...(resource.commitSha ? { "vcs.ref.head.revision": resource.commitSha } : {}),
    ...(resource.platform ? { "mobile.platform": resource.platform } : {}),
  });
}

export function normalizeOtlpTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("A telemetry endpoint is required");

  const parsed = new URL(trimmed);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path || path === "/") parsed.pathname = "/v1/traces";
  else if (!path.endsWith("/v1/traces")) parsed.pathname = `${path}/v1/traces`;
  else parsed.pathname = path;
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
    this.span.setAttribute(name, toOtelValue(value));
    return this;
  }

  recordException(error: unknown, attributes: Attributes = {}): void {
    if (error instanceof Error) this.span.recordException(error);
    else this.span.recordException(String(error));
    this.span.setAttributes(toOtelAttributes(attributes));
    this.span.setStatus({ code: SpanStatusCode.ERROR });
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
  traceContext(): undefined {
    return undefined;
  }
  end(): void {}
}

export class OtlpReactNativeAdapter implements TelemetryAdapter {
  readonly endpoint: string;
  readonly #provider: WebTracerProvider;
  readonly #tracer;
  #shutdown = false;

  constructor(config: OtlpReactNativeAdapterConfig) {
    this.endpoint = normalizeOtlpTracesEndpoint(config.endpoint);
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

    this.#provider = new WebTracerProvider({
      resource: resourceFromAttributes(resourceAttributes(config.resource)),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRate) }),
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

  startSpan(name: string, attributes: Attributes = {}): TraceableTelemetrySpan {
    if (this.#shutdown) return new NoopTelemetrySpan();
    const span = this.#tracer.startSpan(name, {
      kind: SpanKind.INTERNAL,
      attributes: toOtelAttributes(attributes),
    });
    return new OtlpTelemetrySpan(span);
  }

  currentTraceContext(): TraceContext | undefined {
    const span = trace.getSpan(context.active());
    return span ? spanContext(span) : undefined;
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
