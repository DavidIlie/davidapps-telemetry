// This root entry point is runtime-neutral. Provider registration lives in
// `@davidapps/telemetry-next/node` so Edge evaluation never imports Node code.
export {
  createNextRequestErrorHandler,
  type NextRequestErrorContext,
  type NextRequestErrorDetails,
  type NextRequestErrorHandler,
  type NextRequestErrorHandlerConfig,
  type NextRequestErrorReporter,
} from "./request-error.js";
