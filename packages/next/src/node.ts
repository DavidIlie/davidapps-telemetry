import { registerOTel, type Configuration } from "@vercel/otel";
import {
  createNodeTelemetry,
  telemetryResourceAttributes,
  type NodeTelemetryClient,
  type NodeTelemetryConfig,
} from "@davidapps/telemetry-node";
const REGISTRATION = Symbol.for("@davidapps/telemetry-next/registration");

type GlobalWithRegistration = typeof globalThis & {
  [REGISTRATION]?: NodeTelemetryClient;
};

export interface RegisterNextTelemetryConfig extends NodeTelemetryConfig {
  otel?: Omit<Configuration, "attributes" | "serviceName">;
}

/**
 * Register the one OpenTelemetry provider used by the Next.js Node runtime.
 * Import this entry point dynamically behind `NEXT_RUNTIME === "nodejs"`.
 */
export function registerNextTelemetry(
  config: RegisterNextTelemetryConfig,
): NodeTelemetryClient {
  if (
    process.env.NEXT_RUNTIME !== undefined &&
    process.env.NEXT_RUNTIME !== "nodejs"
  ) {
    throw new Error(
      "@davidapps/telemetry-next/node can only register in the Next.js Node runtime",
    );
  }

  const sharedGlobal = globalThis as GlobalWithRegistration;
  const existing = sharedGlobal[REGISTRATION];
  if (existing) return existing;

  registerOTel({
    ...config.otel,
    serviceName: config.resource.serviceName,
    attributes: telemetryResourceAttributes(config.resource),
  });

  const client = createNodeTelemetry(config);
  sharedGlobal[REGISTRATION] = client;
  return client;
}

export {
  createNextRequestErrorHandler,
  type NextRequestErrorHandler,
  type NextRequestErrorHandlerConfig,
} from "./request-error.js";
