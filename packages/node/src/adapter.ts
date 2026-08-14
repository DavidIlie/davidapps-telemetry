import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Histogram,
  type Span,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type {
  Attributes,
  AttributeValue,
  TelemetryAdapter,
  TelemetryResource,
  TelemetrySignal,
  TelemetrySpan,
  TraceContext,
} from "@davidapps/telemetry-core";
import {
  telemetryResourceAttributes,
  toOtelAttributes,
  toOtelAttributeValue,
} from "./attributes.js";

const INSTRUMENTATION_VERSION = "0.1.0";

const severityNumbers = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

function exceptionForOtel(error: unknown): Error | string {
  if (error instanceof Error) return error;
  return typeof error === "string" ? error : String(error);
}

function signalAttributes(signal: TelemetrySignal) {
  return {
    ...telemetryResourceAttributes(signal.resource),
    ...toOtelAttributes(signal.attributes),
    "telemetry.signal.id": signal.id,
    "telemetry.signal.type": signal.type,
  };
}

export class OpenTelemetrySpan implements TelemetrySpan {
  readonly #span: Span;

  constructor(span: Span) {
    this.#span = span;
  }

  setAttribute(name: string, value: AttributeValue): this {
    this.#span.setAttribute(name, toOtelAttributeValue(value));
    return this;
  }

  recordException(error: unknown, attributes: Attributes = {}): void {
    this.#span.setAttributes(toOtelAttributes(attributes));
    this.#span.recordException(exceptionForOtel(error));
    this.#span.setStatus({ code: SpanStatusCode.ERROR });
  }

  end(): void {
    this.#span.end();
  }
}

export interface OpenTelemetryAdapterConfig {
  resource: TelemetryResource;
  instrumentationName?: string;
  instrumentationVersion?: string;
  structuredConsole?: boolean;
  shutdown?: () => void | Promise<void>;
}

export class OpenTelemetryAdapter implements TelemetryAdapter {
  readonly #instrumentationName: string;
  readonly #instrumentationVersion: string;
  readonly #resource: TelemetryResource;
  readonly #structuredConsole: boolean;
  readonly #shutdown: (() => void | Promise<void>) | undefined;
  readonly #histograms = new Map<string, Histogram>();

  constructor(config: OpenTelemetryAdapterConfig) {
    this.#resource = config.resource;
    this.#instrumentationName =
      config.instrumentationName ?? config.resource.serviceName;
    this.#instrumentationVersion =
      config.instrumentationVersion ?? INSTRUMENTATION_VERSION;
    this.#structuredConsole = config.structuredConsole ?? true;
    this.#shutdown = config.shutdown;
  }

  send(signal: TelemetrySignal): void {
    const attributes = signalAttributes(signal);

    switch (signal.type) {
      case "event": {
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          activeSpan.addEvent(signal.name, attributes, new Date(signal.timestamp));
          return;
        }

        const span = this.#tracer().startSpan(signal.name, {
          kind: SpanKind.INTERNAL,
          attributes,
          startTime: new Date(signal.timestamp),
        });
        span.addEvent(signal.name, attributes, new Date(signal.timestamp));
        span.end();
        return;
      }

      case "exception": {
        const activeSpan = trace.getActiveSpan();
        const span =
          activeSpan ??
          this.#tracer().startSpan("exception", {
            kind: SpanKind.INTERNAL,
            attributes,
            startTime: new Date(signal.timestamp),
          });

        span.setAttributes(attributes);
        span.recordException({
          name: signal.exception.name,
          message: signal.exception.message,
          ...(signal.exception.stack ? { stack: signal.exception.stack } : {}),
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: signal.exception.message,
        });
        if (!activeSpan) span.end();
        return;
      }

      case "log": {
        logs
          .getLogger(this.#instrumentationName, this.#instrumentationVersion)
          .emit({
            body: signal.message,
            severityText: signal.level.toUpperCase(),
            severityNumber: severityNumbers[signal.level],
            attributes,
            timestamp: new Date(signal.timestamp),
          });

        if (this.#structuredConsole) {
          const activeTrace = currentTraceContext();
          const record = JSON.stringify({
            ...attributes,
            timestamp: signal.timestamp,
            level: signal.level,
            message: signal.message,
            service_name: signal.resource.serviceName,
            ...(signal.resource.serviceVersion
              ? { service_version: signal.resource.serviceVersion }
              : {}),
            ...(activeTrace
              ? {
                  trace_id: activeTrace.traceId,
                  span_id: activeTrace.spanId,
                }
              : {}),
          });
          console[signal.level](record);
        }
        return;
      }

      case "measurement": {
        const key = `${signal.name}\u0000${signal.unit ?? ""}`;
        let histogram = this.#histograms.get(key);

        if (!histogram) {
          histogram = metrics
            .getMeter(this.#instrumentationName, this.#instrumentationVersion)
            .createHistogram(signal.name, {
              ...(signal.unit ? { unit: signal.unit } : {}),
            });
          this.#histograms.set(key, histogram);
        }

        histogram.record(signal.value, attributes);
      }
    }
  }

  startSpan(name: string, attributes: Attributes = {}): TelemetrySpan {
    const span = this.#tracer().startSpan(name, {
      attributes: {
        ...telemetryResourceAttributes(this.#resource),
        ...toOtelAttributes(attributes),
      },
    });
    return new OpenTelemetrySpan(span);
  }

  currentTraceContext(): TraceContext | undefined {
    return currentTraceContext();
  }

  async withActiveSpan<T>(
    name: string,
    operation: () => T | Promise<T>,
    attributes: Attributes = {},
  ): Promise<T> {
    return this.#tracer().startActiveSpan(
      name,
      {
        attributes: {
          ...telemetryResourceAttributes(this.#resource),
          ...toOtelAttributes(attributes),
        },
      },
      async (span) => {
        try {
          return await operation();
        } catch (error) {
          span.recordException(exceptionForOtel(error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            ...(error instanceof Error ? { message: error.message } : {}),
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async shutdown(): Promise<void> {
    await this.#shutdown?.();
  }

  #tracer() {
    return trace.getTracer(
      this.#instrumentationName,
      this.#instrumentationVersion,
    );
  }
}

export function createOpenTelemetryAdapter(
  config: OpenTelemetryAdapterConfig,
): OpenTelemetryAdapter {
  return new OpenTelemetryAdapter(config);
}

export function currentTraceContext(): TraceContext | undefined {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (!spanContext) return undefined;

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
  };
}

export function startSpan(
  name: string,
  attributes: Attributes = {},
): TelemetrySpan {
  return new OpenTelemetrySpan(
    trace.getTracer("@davidapps/telemetry-node").startSpan(name, {
      attributes: toOtelAttributes(attributes),
    }),
  );
}

export async function withSpan<T>(
  name: string,
  operation: () => T | Promise<T>,
  attributes: Attributes = {},
): Promise<T> {
  return trace
    .getTracer("@davidapps/telemetry-node")
    .startActiveSpan(
      name,
      { attributes: toOtelAttributes(attributes) },
      async (span) => {
        try {
          return await operation();
        } catch (error) {
          span.recordException(exceptionForOtel(error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            ...(error instanceof Error ? { message: error.message } : {}),
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
}

export function recordException(
  error: unknown,
  attributes: Attributes = {},
): void {
  const activeSpan = trace.getActiveSpan();
  const span = activeSpan ?? trace.getTracer("@davidapps/telemetry-node").startSpan("exception");
  span.setAttributes(toOtelAttributes(attributes));
  span.recordException(exceptionForOtel(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    ...(error instanceof Error ? { message: error.message } : {}),
  });
  if (!activeSpan) span.end();
}
