import {
  LogLevel as FaroLogLevel,
  type Faro,
} from "@grafana/faro-web-sdk";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type {
  AttributeValue,
  Attributes,
  TelemetryAdapter,
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
  sanitizeSignal,
} from "@davidilie/telemetry-core";
import {
  toOtelAttributes,
  toStringAttributes,
  toStringResourceAttributes,
} from "./attributes.js";

const FARO_LOG_LEVELS = {
  debug: FaroLogLevel.DEBUG,
  info: FaroLogLevel.INFO,
  warn: FaroLogLevel.WARN,
  error: FaroLogLevel.ERROR,
} as const;

class NoopWebSpan implements TelemetrySpan {
  setAttribute(): this {
    return this;
  }

  recordException(): void {}
  setStatus(): this {
    return this;
  }
  end(): void {}
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

function timestampOverwriteMs(timestamp: string): number | undefined {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function asError(error: unknown): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const safe = new Error(redactText(original.message), {
    ...(original.cause !== undefined
      ? { cause: redactText(String(original.cause)) }
      : {}),
  });
  safe.name = redactText(original.name, 256);
  if (original.stack) safe.stack = redactText(original.stack, 16_384);
  return safe;
}

function signalContext(signal: TelemetrySignal): Record<string, string> {
  // Resource identity is trusted and must win over arbitrary signal context.
  // It is converted separately because the generic sanitizer rejects callers
  // attempting to set reserved identity keys.
  return {
    ...toStringAttributes({
      ...signal.attributes,
      "telemetry.signal.id": signal.id,
    }),
    ...toStringResourceAttributes(signal.resource),
  };
}

export class FaroTelemetryAdapter implements TelemetryAdapter {
  readonly #faro: Faro;

  constructor(faro: Faro) {
    this.#faro = faro;
  }

  send(signal: TelemetrySignal): void {
    signal = sanitizeSignal(signal);
    const context = signalContext(signal);
    const timestamp = timestampOverwriteMs(signal.timestamp);
    const timestampOptions =
      timestamp === undefined ? {} : { timestampOverwriteMs: timestamp };

    switch (signal.type) {
      case "event":
        this.#faro.api.pushEvent(signal.name, context, undefined, timestampOptions);
        return;
      case "exception": {
        const error = new Error(signal.exception.message, {
          ...(signal.exception.cause ? { cause: signal.exception.cause } : {}),
        });
        error.name = signal.exception.name;
        if (signal.exception.stack) error.stack = signal.exception.stack;

        this.#faro.api.pushError(error, {
          type: signal.exception.name,
          context,
          originalError: error,
          ...timestampOptions,
        });
        return;
      }
      case "log":
        this.#faro.api.pushLog([signal.message], {
          level: FARO_LOG_LEVELS[signal.level],
          context,
          ...timestampOptions,
        });
        return;
      case "measurement":
        this.#faro.api.pushMeasurement(
          {
            type: signal.name,
            values: { value: signal.value },
          },
          {
            context: {
              ...context,
              ...(signal.unit ? { "measurement.unit": signal.unit } : {}),
            },
            ...timestampOptions,
          },
        );
    }
  }

  startSpan(
    name: string,
    attributes: Attributes = {},
    options: TelemetrySpanOptions = {},
  ): TelemetrySpan {
    const otel = this.#faro.api.getOTEL();
    if (!otel) return new NoopWebSpan();

    const span = otel.trace
      .getTracer("@davidilie/telemetry-web")
      .startSpan(redactText(name, 256), {
        kind: spanKinds[options.kind ?? "internal"],
        attributes: toOtelAttributes(sanitizeAttributes(attributes)),
      });

    return {
      setAttribute(key: string, value: AttributeValue) {
        const safe = sanitizeAttributes({ [key]: value });
        if (safe[key] !== undefined) {
          span.setAttribute(key, toOtelAttributes(safe)[key] ?? "");
        }
        return this;
      },
      recordException(error: unknown, exceptionAttributes: Attributes = {}) {
        const normalized = asError(error);
        span.setAttributes(
          toOtelAttributes(sanitizeAttributes(exceptionAttributes)),
        );
        span.recordException(normalized);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: normalized.message,
        });
      },
      setStatus(status: TelemetrySpanStatus, message?: string) {
        span.setStatus({
          code: spanStatuses[status],
          ...(message ? { message: redactText(message) } : {}),
        });
        return this;
      },
      end() {
        span.end();
      },
    };
  }

  currentTraceContext(): TraceContext | undefined {
    const trace = this.#faro.api.getTraceContext();
    if (!trace) return undefined;
    return { traceId: trace.trace_id, spanId: trace.span_id };
  }

  shutdown(): void {
    this.#faro.pause();
  }
}
