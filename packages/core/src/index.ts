export { TelemetryClient, createTelemetryClient } from "./client.js";
export { sanitizeAttributes, sanitizeSignal } from "./sanitize.js";
export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  BeforeSend,
  EventSignal,
  ExceptionSignal,
  LogLevel,
  LogSignal,
  MeasurementSignal,
  TelemetryAdapter,
  TelemetryConfig,
  TelemetryResource,
  TelemetrySignal,
  TelemetrySpan,
  TraceContext,
} from "./types.js";

