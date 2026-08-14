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
import {
  telemetryResourceAttributes,
  toOtelAttributes,
  toOtelAttributeValue,
} from "./attributes.js";

const severityNumbers = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

function exceptionForOtel(error: unknown): Error | string {
  if (error instanceof Error) {
    const safe = new Error(redactText(error.message), {
      ...(error.cause !== undefined
        ? { cause: redactText(String(error.cause)) }
        : {}),
    });
    safe.name = redactText(error.name, 256);
    if (error.stack) safe.stack = redactText(error.stack, 16_384);
    return safe;
  }
  return redactText(typeof error === "string" ? error : String(error));
}

function signalAttributes(signal: TelemetrySignal) {
  return {
    ...toOtelAttributes(signal.attributes),
    ...telemetryResourceAttributes(signal.resource),
    "telemetry.signal.id": signal.id,
    "telemetry.signal.type": signal.type,
  };
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

const VALID_INSTRUMENT_NAME = /^[A-Za-z][A-Za-z0-9_.\-/]{0,254}$/;

export type MeasurementMode = "metrics" | "spans" | "both";

export class OpenTelemetrySpan implements TelemetrySpan {
  readonly #span: Span;

  constructor(span: Span) {
    this.#span = span;
  }

  setAttribute(name: string, value: AttributeValue): this {
    const safe = sanitizeAttributes({ [name]: value });
    if (safe[name] !== undefined) {
      this.#span.setAttribute(name, toOtelAttributeValue(safe[name]));
    }
    return this;
  }

  recordException(error: unknown, attributes: Attributes = {}): void {
    this.#span.setAttributes(toOtelAttributes(sanitizeAttributes(attributes)));
    this.#span.recordException(exceptionForOtel(error));
    this.#span.setStatus({ code: SpanStatusCode.ERROR });
  }

  setStatus(status: TelemetrySpanStatus, message?: string): this {
    this.#span.setStatus({
      code: spanStatuses[status],
      ...(message ? { message: redactText(message) } : {}),
    });
    return this;
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
  /** How `measure()` is represented. Defaults to trace spans. */
  measurementMode?: MeasurementMode;
  /** Explicit low-cardinality signal attributes allowed onto metric points. */
  metricAttributeAllowlist?: readonly string[];
  /** Bound on distinct histogram name/unit pairs. Defaults to 64. */
  maxMetricInstruments?: number;
  /** Internal: provider-managed trace sampling still needs a log decision. */
  logSampleRate?: number;
  shutdown?: () => void | Promise<void>;
}

export class OpenTelemetryAdapter implements TelemetryAdapter {
  readonly #instrumentationName: string;
  readonly #instrumentationVersion: string | undefined;
  readonly #resource: TelemetryResource;
  readonly #structuredConsole: boolean;
  readonly #measurementMode: MeasurementMode;
  readonly #metricAttributeAllowlist: ReadonlySet<string>;
  readonly #maxMetricInstruments: number;
  readonly #logSampleRate: number;
  readonly #shutdown: (() => void | Promise<void>) | undefined;
  readonly #histograms = new Map<string, Histogram>();

  constructor(config: OpenTelemetryAdapterConfig) {
    this.#resource = sanitizeResource(config.resource);
    this.#instrumentationName =
      config.instrumentationName ?? this.#resource.serviceName;
    this.#instrumentationVersion = config.instrumentationVersion;
    this.#structuredConsole = config.structuredConsole ?? true;
    this.#measurementMode = config.measurementMode ?? "spans";
    this.#metricAttributeAllowlist = new Set(
      config.metricAttributeAllowlist ?? [],
    );
    this.#maxMetricInstruments = Math.max(
      0,
      Math.floor(
        Number.isFinite(config.maxMetricInstruments)
          ? (config.maxMetricInstruments ?? 64)
          : 64,
      ),
    );
    this.#logSampleRate = Number.isFinite(config.logSampleRate)
      ? Math.min(1, Math.max(0, config.logSampleRate ?? 1))
      : 1;
    this.#shutdown = config.shutdown;
  }

  send(signal: TelemetrySignal): void {
    signal = sanitizeSignal(signal);
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
        span.end(new Date(signal.timestamp));
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
        if (!activeSpan) span.end(new Date(signal.timestamp));
        return;
      }

      case "log": {
        if (Math.random() >= this.#logSampleRate) return;
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
        if (
          this.#measurementMode === "spans" ||
          this.#measurementMode === "both"
        ) {
          const span = this.#tracer().startSpan(`measurement:${signal.name}`, {
            kind: SpanKind.INTERNAL,
            attributes: {
              ...attributes,
              "telemetry.measurement.value": signal.value,
              ...(signal.unit
                ? { "telemetry.measurement.unit": signal.unit }
                : {}),
            },
            startTime: new Date(signal.timestamp),
          });
          span.end(new Date(signal.timestamp));
        }

        if (this.#measurementMode === "spans") return;
        if (!VALID_INSTRUMENT_NAME.test(signal.name)) return;

        const key = `${signal.name}\u0000${signal.unit ?? ""}`;
        let histogram = this.#histograms.get(key);

        if (!histogram) {
          if (this.#histograms.size >= this.#maxMetricInstruments) return;
          histogram = metrics
            .getMeter(this.#instrumentationName, this.#instrumentationVersion)
            .createHistogram(signal.name, {
              ...(signal.unit ? { unit: signal.unit } : {}),
            });
          this.#histograms.set(key, histogram);
        }

        // Resource attributes are exported by the MeterProvider. Never copy
        // signal IDs, revisions, or arbitrary event attributes onto points:
        // each unique label set creates a Prometheus/VictoriaMetrics series.
        const metricAttributes = Object.fromEntries(
          Object.entries(signal.attributes).filter(([name]) =>
            this.#metricAttributeAllowlist.has(name),
          ),
        );
        histogram.record(signal.value, toOtelAttributes(metricAttributes));
      }
    }
  }

  startSpan(
    name: string,
    attributes: Attributes = {},
    options: TelemetrySpanOptions = {},
  ): TelemetrySpan {
    const span = this.#tracer().startSpan(redactText(name, 256), {
      kind: spanKinds[options.kind ?? "internal"],
      attributes: {
        ...toOtelAttributes(sanitizeAttributes(attributes)),
        ...telemetryResourceAttributes(this.#resource),
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
    options: TelemetrySpanOptions = {},
  ): Promise<T> {
    let operationRan = false;
    let operationSucceeded = false;
    let operationResult: T | undefined;
    let operationError: unknown;

    try {
      await this.#tracer().startActiveSpan(
        redactText(name, 256),
        {
          kind: spanKinds[options.kind ?? "internal"],
          attributes: {
            ...toOtelAttributes(sanitizeAttributes(attributes)),
            ...telemetryResourceAttributes(this.#resource),
          },
        },
        async (span) => {
          operationRan = true;
          try {
            operationResult = await operation();
            operationSucceeded = true;
          } catch (error) {
            operationError = error;
            try {
              span.recordException(exceptionForOtel(error));
              span.setStatus({
                code: SpanStatusCode.ERROR,
                ...(error instanceof Error
                  ? { message: redactText(error.message) }
                  : {}),
              });
            } catch {
              // Telemetry must not replace the original application error.
            }
          } finally {
            try {
              span.end();
            } catch {
              // Ending telemetry is best effort and must not change app flow.
            }
          }
        },
      );
    } catch (telemetryError) {
      if (!operationRan) throw telemetryError;
      // A provider failure after the callback must not replace either the
      // application's result or its original error.
    }

    if (operationSucceeded) return operationResult as T;
    if (operationRan) throw operationError;
    // Defensive fallback for a non-conforming tracer that returns without
    // invoking its callback.
    return operation();
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
  options: TelemetrySpanOptions = {},
): TelemetrySpan {
  return new OpenTelemetrySpan(
    trace.getTracer("@davidilie/telemetry-node").startSpan(redactText(name, 256), {
      kind: spanKinds[options.kind ?? "internal"],
      attributes: toOtelAttributes(sanitizeAttributes(attributes)),
    }),
  );
}

export async function withSpan<T>(
  name: string,
  operation: () => T | Promise<T>,
  attributes: Attributes = {},
  options: TelemetrySpanOptions = {},
): Promise<T> {
  return trace
    .getTracer("@davidilie/telemetry-node")
    .startActiveSpan(
      redactText(name, 256),
      {
        kind: spanKinds[options.kind ?? "internal"],
        attributes: toOtelAttributes(sanitizeAttributes(attributes)),
      },
      async (span) => {
        try {
          return await operation();
        } catch (error) {
          try {
            span.recordException(exceptionForOtel(error));
            span.setStatus({
              code: SpanStatusCode.ERROR,
              ...(error instanceof Error
                ? { message: redactText(error.message) }
                : {}),
            });
          } catch {
            // Preserve the original application error.
          }
          throw error;
        } finally {
          try {
            span.end();
          } catch {
            // Telemetry is fail-open.
          }
        }
      },
    );
}

export function recordException(
  error: unknown,
  attributes: Attributes = {},
): void {
  const activeSpan = trace.getActiveSpan();
  const span = activeSpan ?? trace.getTracer("@davidilie/telemetry-node").startSpan("exception");
  span.setAttributes(toOtelAttributes(sanitizeAttributes(attributes)));
  span.recordException(exceptionForOtel(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    ...(error instanceof Error ? { message: redactText(error.message) } : {}),
  });
  if (!activeSpan) span.end();
}
