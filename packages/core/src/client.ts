import { sanitizeAttributes, sanitizeSignal } from "./sanitize.js";
import type {
  Attributes,
  AttributeValue,
  BeforeSend,
  LogLevel,
  TelemetryAdapter,
  TelemetryConfig,
  TelemetryResource,
  TelemetrySignal,
  TelemetrySpan,
  TraceContext,
} from "./types.js";

class NoopSpan implements TelemetrySpan {
  setAttribute(): this {
    return this;
  }

  recordException(): void {}
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

export class TelemetryClient {
  readonly #adapter: TelemetryAdapter;
  readonly #beforeSend: BeforeSend | undefined;
  readonly #resource: TelemetryResource;
  readonly #sampleRate: number;
  readonly #debug: boolean;
  readonly #pending = new Set<Promise<void>>();
  #context: Record<string, AttributeValue> = {};
  #enabled: boolean;
  #consent: "granted" | "denied" | "pending";

  constructor(config: TelemetryConfig) {
    this.#adapter = config.adapter;
    this.#resource = config.resource;
    this.#beforeSend = config.beforeSend;
    this.#sampleRate = Math.min(1, Math.max(0, config.sampleRate ?? 1));
    this.#enabled = config.enabled ?? true;
    this.#consent = config.consent ?? "granted";
    this.#debug = config.debug ?? false;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  setConsent(consent: "granted" | "denied" | "pending"): void {
    this.#consent = consent;
  }

  setContext(attributes: Attributes): void {
    this.#context = { ...this.#context, ...sanitizeAttributes(attributes) };
  }

  clearContext(): void {
    this.#context = {};
  }

  capture(name: string, attributes: Attributes = {}): void {
    this.#dispatch({
      ...this.#base(attributes),
      type: "event",
      name,
    });
  }

  captureException(error: unknown, attributes: Attributes = {}): void {
    this.#dispatch({
      ...this.#base(attributes),
      type: "exception",
      exception: normalizeException(error),
    });
  }

  log(level: LogLevel, message: string, attributes: Attributes = {}): void {
    this.#dispatch({
      ...this.#base(attributes),
      type: "log",
      level,
      message,
    });
  }

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

  startSpan(name: string, attributes: Attributes = {}): TelemetrySpan {
    if (!this.#canSend() || !this.#adapter.startSpan) return new NoopSpan();
    return this.#adapter.startSpan(name, sanitizeAttributes(attributes));
  }

  async withSpan<T>(
    name: string,
    operation: () => T | Promise<T>,
    attributes: Attributes = {},
  ): Promise<T> {
    const span = this.startSpan(name, attributes);
    try {
      return await operation();
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  currentTraceContext(): TraceContext | undefined {
    return this.#adapter.currentTraceContext?.();
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
    await this.#adapter.flush?.();
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await this.#adapter.shutdown?.();
    this.#enabled = false;
  }

  #base(attributes: Attributes) {
    return {
      id: makeId(),
      timestamp: new Date().toISOString(),
      resource: this.#resource,
      attributes: sanitizeAttributes({ ...this.#context, ...attributes }),
    };
  }

  #canSend(): boolean {
    return this.#enabled && this.#consent === "granted" && Math.random() <= this.#sampleRate;
  }

  #dispatch(signal: TelemetrySignal): void {
    if (!this.#canSend()) return;

    const sanitized = sanitizeSignal(signal);
    const processed = this.#beforeSend ? this.#beforeSend(sanitized) : sanitized;
    const pending = Promise.resolve(processed)
      .then(async (processed) => {
        if (!processed) return;
        if (this.#debug) console.debug("[davidapps-telemetry]", processed);
        await this.#adapter.send(processed);
      })
      .catch((error: unknown) => {
        if (this.#debug) console.warn("[davidapps-telemetry] transport failed", error);
      })
      .finally(() => {
        this.#pending.delete(pending);
      });

    this.#pending.add(pending);
  }
}

export function createTelemetryClient(config: TelemetryConfig): TelemetryClient {
  return new TelemetryClient(config);
}
