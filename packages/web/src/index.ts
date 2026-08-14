export { FaroTelemetryAdapter } from "./adapter.js";
export {
  getWebTelemetry,
  getWebTelemetryClient,
  initializeWebTelemetry,
  shutdownWebTelemetry,
} from "./initialize.js";
export type { WebTelemetry, WebTelemetryConfig } from "./initialize.js";
export type {
  BeforeSendHook as FaroBeforeSend,
  Faro,
  Patterns as FaroPatterns,
  TransportItem as FaroTransportItem,
} from "@grafana/faro-web-sdk";
