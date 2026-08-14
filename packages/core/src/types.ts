/** Primitive values accepted by every runtime adapter. */
export type AttributePrimitive = string | number | boolean;

/**
 * A portable OpenTelemetry-compatible attribute value.
 *
 * Arrays may contain mixed primitive values at the core boundary. Adapters
 * normalize them to the homogeneous arrays required by OpenTelemetry.
 */
export type AttributeValue = AttributePrimitive | readonly AttributePrimitive[];

/** Attributes are copied and sanitized before they leave the core package. */
export type Attributes = Readonly<Record<string, AttributeValue | null | undefined>>;

/** Stable identity attached to every signal created by one client. */
export interface TelemetryResource {
  /** Stable service name, for example `zerocut-web`. */
  serviceName: string;
  /** Exact deployed source revision. DavidApps uses the full Git commit SHA. */
  serviceVersion?: string;
  /** Deployment environment such as `production`, `staging`, or `development`. */
  environment?: string;
  /** Optional namespace used to distinguish related services. */
  namespace?: string;
  /** Canonical source repository URL. Query strings and credentials are removed. */
  repositoryUrl?: string;
  /** Exact source revision, also exported as `vcs.ref.head.revision`. */
  commitSha?: string;
  /** Runtime platform such as `web`, `node`, `ios`, or `android`. */
  platform?: string;
  /** Additional low-cardinality resource attributes. */
  attributes?: Attributes;
}

interface BaseSignal {
  id: string;
  timestamp: string;
  resource: TelemetryResource;
  attributes: Record<string, AttributeValue>;
}

export interface EventSignal extends BaseSignal {
  type: "event";
  name: string;
}

export interface ExceptionSignal extends BaseSignal {
  type: "exception";
  exception: {
    name: string;
    message: string;
    stack?: string;
    cause?: string;
  };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSignal extends BaseSignal {
  type: "log";
  level: LogLevel;
  message: string;
}

export interface MeasurementSignal extends BaseSignal {
  type: "measurement";
  name: string;
  value: number;
  unit?: string;
}

export type TelemetrySignal = EventSignal | ExceptionSignal | LogSignal | MeasurementSignal;

export interface TraceContext {
  /** 32-character lowercase hexadecimal trace identifier. */
  traceId: string;
  /** 16-character lowercase hexadecimal span identifier. */
  spanId: string;
  /** W3C trace flags. */
  traceFlags?: number;
}

/** Portable span kinds understood by all bundled adapters. */
export type TelemetrySpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

/** Portable span status values understood by all bundled adapters. */
export type TelemetrySpanStatus = "unset" | "ok" | "error";

/** Options that affect span semantics without becoming span attributes. */
export interface TelemetrySpanOptions {
  kind?: TelemetrySpanKind;
}

/** A fail-open span handle. Implementations must make repeated `end()` calls safe. */
export interface TelemetrySpan {
  /** Set one sanitized span attribute. Reserved identity keys are ignored. */
  setAttribute(name: string, value: AttributeValue): this;
  /** Record a sanitized exception and optional sanitized attributes. */
  recordException(error: unknown, attributes?: Attributes): void;
  /** Set the portable span status and an optional sanitized message. */
  setStatus(status: TelemetrySpanStatus, message?: string): this;
  /** Return this span's context when the adapter supports propagation. */
  traceContext?(): TraceContext | undefined;
  /** End the span. */
  end(): void;
}

/**
 * Runtime adapter contract.
 *
 * Implement this interface to send the stable core signal model to another
 * transport. Adapter failures are caught by `TelemetryClient` and never change
 * application control flow.
 */
export interface TelemetryAdapter {
  send(signal: TelemetrySignal): void | Promise<void>;
  startSpan?(
    name: string,
    attributes?: Attributes,
    options?: TelemetrySpanOptions,
  ): TelemetrySpan;
  currentTraceContext?(): TraceContext | undefined;
  flush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

/** Final signal hook. Returning `null` discards the signal. Output is sanitized again. */
export type BeforeSend = (
  signal: TelemetrySignal,
) => TelemetrySignal | null | Promise<TelemetrySignal | null>;

/** Context supplied to `onError` when optional telemetry code fails. */
export interface TelemetryErrorContext {
  operation: "beforeSend" | "send" | "startSpan" | "span" | "flush" | "shutdown";
  signal?: TelemetrySignal;
}

/** Receives telemetry failures without allowing them to escape into application code. */
export type TelemetryErrorHandler = (
  error: unknown,
  context: TelemetryErrorContext,
) => void | Promise<void>;

/** Runtime-neutral client configuration. */
export interface TelemetryConfig {
  /** Runtime transport adapter. */
  adapter: TelemetryAdapter;
  /** Stable identity copied and sanitized when the client is created. */
  resource: TelemetryResource;
  /** Optional final transform/drop hook. It may be asynchronous and is fail-open. */
  beforeSend?: BeforeSend;
  /** Initial custom-signal state. Defaults to `true`. */
  enabled?: boolean;
  /** Per-signal sampling probability from `0` through `1`. Defaults to `1`. */
  sampleRate?: number;
  /** Initial consent state. Only `granted` sends signals. Defaults to `granted`. */
  consent?: "granted" | "denied" | "pending";
  /** Log sanitized signals and transport failures to the console. */
  debug?: boolean;
  /** Optional diagnostics hook for adapter/hook/lifecycle failures. */
  onError?: TelemetryErrorHandler;
}
