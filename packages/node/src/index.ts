export {
  OpenTelemetryAdapter,
  OpenTelemetrySpan,
  createOpenTelemetryAdapter,
  currentTraceContext,
  recordException,
  startSpan,
  withSpan,
  type OpenTelemetryAdapterConfig,
} from "./adapter.js";
export {
  NodeTelemetryClient,
  createNodeTelemetry,
  type NodeTelemetryConfig,
} from "./client.js";
export {
  telemetryResourceAttributes,
  toOtelAttributeValue,
  toOtelAttributes,
} from "./attributes.js";
