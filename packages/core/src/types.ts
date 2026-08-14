export type AttributePrimitive = string | number | boolean;
export type AttributeValue = AttributePrimitive | readonly AttributePrimitive[];
export type Attributes = Readonly<Record<string, AttributeValue | null | undefined>>;

export interface TelemetryResource {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  namespace?: string;
  repositoryUrl?: string;
  commitSha?: string;
  platform?: string;
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
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

export interface TelemetrySpan {
  setAttribute(name: string, value: AttributeValue): this;
  recordException(error: unknown, attributes?: Attributes): void;
  end(): void;
}

export interface TelemetryAdapter {
  send(signal: TelemetrySignal): void | Promise<void>;
  startSpan?(name: string, attributes?: Attributes): TelemetrySpan;
  currentTraceContext?(): TraceContext | undefined;
  flush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export type BeforeSend = (
  signal: TelemetrySignal,
) => TelemetrySignal | null | Promise<TelemetrySignal | null>;

export interface TelemetryConfig {
  adapter: TelemetryAdapter;
  resource: TelemetryResource;
  beforeSend?: BeforeSend;
  enabled?: boolean;
  sampleRate?: number;
  consent?: "granted" | "denied" | "pending";
  debug?: boolean;
}

