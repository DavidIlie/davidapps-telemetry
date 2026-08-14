import {
  LogLevel as FaroLogLevel,
  type Faro,
} from "@grafana/faro-web-sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import type {
  AttributeValue,
  Attributes,
  TelemetryAdapter,
  TelemetrySignal,
  TelemetrySpan,
  TraceContext,
} from "@davidapps/telemetry-core";
import {
  resourceAttributes,
  toOtelAttributes,
  toStringAttributes,
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
  end(): void {}
}

function timestampOverwriteMs(timestamp: string): number | undefined {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function signalContext(signal: TelemetrySignal): Record<string, string> {
  return toStringAttributes({
    ...resourceAttributes(signal.resource),
    ...signal.attributes,
    "telemetry.signal.id": signal.id,
  });
}

export class FaroTelemetryAdapter implements TelemetryAdapter {
  readonly #faro: Faro;

  constructor(faro: Faro) {
    this.#faro = faro;
  }

  send(signal: TelemetrySignal): void {
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

  startSpan(name: string, attributes: Attributes = {}): TelemetrySpan {
    const otel = this.#faro.api.getOTEL();
    if (!otel) return new NoopWebSpan();

    const span = otel.trace
      .getTracer("@davidapps/telemetry-web")
      .startSpan(name, { attributes: toOtelAttributes(attributes) });

    return {
      setAttribute(key: string, value: AttributeValue) {
        span.setAttribute(key, toOtelAttributes({ [key]: value })[key] ?? "");
        return this;
      },
      recordException(error: unknown, exceptionAttributes: Attributes = {}) {
        const normalized = asError(error);
        span.setAttributes(toOtelAttributes(exceptionAttributes));
        span.recordException(normalized);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: normalized.message,
        });
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
