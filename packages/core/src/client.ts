import {
  redactText,
  sanitizeAttributes,
  sanitizeResource,
  sanitizeSignal,
} from "./sanitize.js";
import type {
  Attributes,
  AttributeValue,
  BeforeSend,
  LogLevel,
  TelemetryAdapter,
  TelemetryConfig,
  TelemetryErrorContext,
  TelemetryErrorHandler,
  TelemetryResource,
  TelemetrySignal,
  TelemetrySpan,
  TelemetrySpanOptions,
  TelemetrySpanStatus,
  TraceContext,
} from "./types.js";

class NoopSpan implements TelemetrySpan {
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

function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeException(error: unknown): {
  name: string;
  message: string;
  stack?: string;
  cause?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: String(error.cause) } : {}),
    };
  }

  return { name: "NonErrorException", message: String(error) };
}

function sanitizedError(error: unknown): Error {
  const normalized = normalizeException(error);
  const result = new Error(redactText(normalized.message), {
    ...(normalized.cause ? { cause: redactText(normalized.cause) } : {}),
  });
  result.name = redactText(normalized.name, 256);
  if (normalized.stack) result.stack = redactText(normalized.stack, 16_384);
  return result;
}

function normalizeSampleRate(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function copyResource(resource: TelemetryResource): TelemetryResource {
  return {
    ...resource,
    attributes: { ...resource.attributes },
  };
}

class SafeSpan implements TelemetrySpan {
  #ended = false;

  constructor(
    private readonly delegate: TelemetrySpan,
    private readonly reportError: (error: unknown) => void,
  ) {}

  setAttribute(name: string, value: AttributeValue): this {
    if (this.#ended) return this;
    const sanitized = sanitizeAttributes({ [name]: value });
    // hasOwn, not `in`: dropped magic keys such as __proto__ still resolve
    // through the prototype chain on a plain object.
    if (!Object.hasOwn(sanitized, name)) return this;

    try {
      this.delegate.setAttribute(name, sanitized[name]!);
    } catch (error) {
      this.reportError(error);
    }
    return this;
  }

  recordException(error: unknown, attributes: Attributes = {}): void {
    if (this.#ended) return;
    try {
      this.delegate.recordException(
        sanitizedError(error),
        sanitizeAttributes(attributes),
      );
    } catch (adapterError) {
      this.reportError(adapterError);
    }
  }

  setStatus(status: TelemetrySpanStatus, message?: string): this {
    if (this.#ended) return this;
    try {
      this.delegate.setStatus(status, message ? redactText(message) : undefined);
    } catch (error) {
      this.reportError(error);
    }
    return this;
  }

  traceContext(): TraceContext | undefined {
    if (this.#ended) return undefined;
    try {
      return this.delegate.traceContext?.();
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.delegate.end();
    } catch (error) {
      this.reportError(error);
    }
  }
}

/**
 * Runtime-neutral, fail-open telemetry client.
 *
 * The client owns privacy filtering, consent, sampling, context, hook ordering,
 * and lifecycle. Runtime adapters only translate already-sanitized signals.
 */
export class TelemetryClient {
  readonly #adapter: TelemetryAdapter;
  readonly #beforeSend: BeforeSend | undefined;
  readonly #onError: TelemetryErrorHandler | undefined;
  readonly #resource: TelemetryResource;
  readonly #sampleRate: number;
  readonly #debug: boolean;
  readonly #pending = new Set<Promise<void>>();
  #context: Record<string, AttributeValue> = {};
  #enabled: boolean;
  #consent: "granted" | "denied" | "pending";
  #acceptingSignals = true;
  #shutdownPromise: Promise<void> | undefined;

  constructor(config: TelemetryConfig) {
    this.#adapter = config.adapter;
    this.#resource = sanitizeResource(config.resource);
    this.#beforeSend = config.beforeSend;
    this.#onError = config.onError;
    this.#sampleRate = normalizeSampleRate(config.sampleRate);
    this.#enabled = config.enabled ?? true;
    this.#consent = config.consent ?? "granted";
    this.#debug = config.debug ?? false;
  }

  /** Enable or disable future custom signals. Already-exported data cannot be recalled. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  /** Change consent for future custom signals. Only `granted` permits export. */
  setConsent(consent: "granted" | "denied" | "pending"): void {
    this.#consent = consent;
  }

  /** Merge sanitized attributes into every future signal from this client. */
  setContext(attributes: Attributes): void {
    this.#context = { ...this.#context, ...sanitizeAttributes(attributes) };
  }

  /** Remove all application context previously set with `setContext`. */
  clearContext(): void {
    this.#context = {};
  }

  /** Capture a stable, named product or lifecycle event. */
  capture(name: string, attributes: Attributes = {}): void {
    this.#dispatch({
      ...this.#base(attributes),
      type: "event",
      name,
    });
  }

  /** Capture a handled or unhandled exception without throwing it. */
  captureException(error: unknown, attributes: Attributes = {}): void {
    this.#dispatch({
      ...this.#base(attributes),
      type: "exception",
      exception: normalizeException(error),
    });
  }

  /** Emit one structured log record. Messages still need to be deliberately PII-free. */
  log(level: LogLevel, message: string, attributes: Attributes = {}): void {
    this.#dispatch({
      ...this.#base(attributes),
      type: "log",
      level,
      message,
    });
  }

  /**
   * Record a numeric measurement.
   *
   * Keep `name`, `unit`, and every attribute low-cardinality. Runtime adapters
   * may apply a stricter metric attribute allowlist.
   */
  measure(name: string, value: number, attributes: Attributes = {}, unit?: string): void {
    if (!Number.isFinite(value)) return;

    this.#dispatch({
      ...this.#base(attributes),
      type: "measurement",
      name,
      value,
      ...(unit ? { unit } : {}),
    });
  }

  /** Start a sanitized span, or a no-op span when disabled, unsampled, or unavailable. */
  startSpan(
    name: string,
    attributes: Attributes = {},
    options: TelemetrySpanOptions = {},
  ): TelemetrySpan {
    if (!this.#canSend() || !this.#adapter.startSpan) return new NoopSpan();

    try {
      const span = this.#adapter.startSpan(
        redactText(name, 256),
        sanitizeAttributes(attributes),
        options,
      );
      return new SafeSpan(span, (error) => {
        this.#reportError(error, { operation: "span" });
      });
    } catch (error) {
      this.#reportError(error, { operation: "startSpan" });
      return new NoopSpan();
    }
  }

  /**
   * Run an operation inside a span and rethrow application errors unchanged.
   * Telemetry failures never prevent the operation from running.
   */
  async withSpan<T>(
    name: string,
    operation: () => T | Promise<T>,
    attributes: Attributes = {},
    options: TelemetrySpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, attributes, options);
    try {
      return await operation();
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  /** Return the active trace context when the adapter exposes one. */
  currentTraceContext(): TraceContext | undefined {
    try {
      return this.#adapter.currentTraceContext?.();
    } catch (error) {
      this.#reportError(error, { operation: "span" });
      return undefined;
    }
  }

  /** Wait for core hooks/sends and ask the adapter to flush its own buffers. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
    try {
      await this.#adapter.flush?.();
    } catch (error) {
      this.#reportError(error, { operation: "flush" });
    }
  }

  /** Disable new signals, drain pending work, and shut the adapter down once. */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#acceptingSignals = false;
    this.#shutdownPromise = (async () => {
      await this.flush();
      try {
        await this.#adapter.shutdown?.();
      } catch (error) {
        this.#reportError(error, { operation: "shutdown" });
      }
    })();
    return this.#shutdownPromise;
  }

  #base(attributes: Attributes) {
    return {
      id: makeId(),
      timestamp: new Date().toISOString(),
      resource: copyResource(this.#resource),
      attributes: sanitizeAttributes({ ...this.#context, ...attributes }),
    };
  }

  #collectionAllowed(): boolean {
    return this.#enabled && this.#consent === "granted";
  }

  #canSendWithoutSampling(): boolean {
    return this.#acceptingSignals && this.#collectionAllowed();
  }

  #canSend(): boolean {
    return this.#canSendWithoutSampling() && Math.random() < this.#sampleRate;
  }

  #dispatch(signal: TelemetrySignal): void {
    if (!this.#canSend()) return;
    const sanitized = sanitizeSignal(signal);

    // Keep the common no-hook path synchronous through adapter.send so fatal
    // runtimes at least enqueue the telemetry before delegating to their crash
    // handler. Every failure is still caught.
    if (!this.#beforeSend) {
      if (!this.#canSendWithoutSampling()) return;
      this.#send(sanitized);
      return;
    }

    const pending = Promise.resolve()
      .then(async () => {
        let processed: TelemetrySignal | null;
        try {
          processed = await this.#beforeSend!(sanitized);
        } catch (error) {
          this.#reportError(error, {
            operation: "beforeSend",
            signal: sanitized,
          });
          return;
        }
        // Consent/enabled changes revoke queued work. Shutdown is different:
        // it stops new calls but deliberately drains work already accepted.
        if (!processed || !this.#collectionAllowed()) return;
        const finalSignal = sanitizeSignal(processed);
        if (this.#debug) console.debug("[davidapps-telemetry]", finalSignal);
        try {
          await this.#adapter.send(finalSignal);
        } catch (error) {
          this.#reportError(error, { operation: "send", signal: finalSignal });
        }
      })
      .finally(() => {
        this.#pending.delete(pending);
      });

    this.#pending.add(pending);
  }

  #send(signal: TelemetrySignal): void {
    if (this.#debug) console.debug("[davidapps-telemetry]", signal);

    let result: void | Promise<void>;
    try {
      result = this.#adapter.send(signal);
    } catch (error) {
      this.#reportError(error, { operation: "send", signal });
      return;
    }

    const pending = Promise.resolve(result)
      .catch((error: unknown) => {
        this.#reportError(error, { operation: "send", signal });
      })
      .finally(() => {
        this.#pending.delete(pending);
      });
    this.#pending.add(pending);
  }

  #reportError(error: unknown, context: TelemetryErrorContext): void {
    if (this.#debug) {
      console.warn(`[davidapps-telemetry] ${context.operation} failed`, error);
    }
    if (!this.#onError) return;

    try {
      void Promise.resolve(this.#onError(error, context)).catch((handlerError) => {
        if (this.#debug) {
          console.warn("[davidapps-telemetry] onError failed", handlerError);
        }
      });
    } catch (handlerError) {
      if (this.#debug) {
        console.warn("[davidapps-telemetry] onError failed", handlerError);
      }
    }
  }
}

/** Create one runtime-neutral telemetry client. */
export function createTelemetryClient(config: TelemetryConfig): TelemetryClient {
  return new TelemetryClient(config);
}
