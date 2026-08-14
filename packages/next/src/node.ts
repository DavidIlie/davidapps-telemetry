import { registerOTel, type Configuration } from "@vercel/otel";
import { sanitizeResource } from "@davidapps/telemetry-core";
import {
  telemetryResourceAttributes,
  NodeTelemetryClient,
  DynamicTelemetrySampler,
  type NodeTelemetryConfig,
} from "@davidapps/telemetry-node";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
const REGISTRATION = Symbol.for("@davidapps/telemetry-next/registration");

type GlobalWithRegistration = typeof globalThis & {
  [REGISTRATION]?: NodeTelemetryClient;
};

export interface RegisterNextTelemetryConfig extends NodeTelemetryConfig {
  otel?: Omit<Configuration, "attributes" | "serviceName" | "traceSampler"> & {
    /** A concrete sampler so dynamic consent can wrap it safely. */
    traceSampler?: Sampler;
  };
}

function traceSampler(config: RegisterNextTelemetryConfig) {
  const configuredRate = Number.isFinite(config.sampleRate)
    ? (config.sampleRate ?? 1)
    : 1;
  const rate = Math.min(1, Math.max(0, configuredRate));
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(rate) });
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
  const resource = sanitizeResource(config.resource);

  const sampler = new DynamicTelemetrySampler(
    config.otel?.traceSampler ?? traceSampler(config),
    {
      enabled: config.enabled ?? true,
      consent: config.consent ?? "granted",
    },
  );

  registerOTel({
    ...config.otel,
    traceSampler: sampler,
    serviceName: resource.serviceName,
    attributes: telemetryResourceAttributes(resource),
  });

  const client = new NodeTelemetryClient({
    ...config,
    resource,
    // registerOTel owns span sampling; the adapter applies the rate once to
    // logs, which are not governed by the trace sampler.
    providerManagedSampling: true,
    onCollectionStateChange: (state) => {
      sampler.setEnabled(state.enabled);
      sampler.setConsent(state.consent);
    },
    measurementMode:
      config.measurementMode ??
      (config.otel?.metricReaders?.length ? "metrics" : "spans"),
  });
  sharedGlobal[REGISTRATION] = client;
  return client;
}

export {
  createNextRequestErrorHandler,
  type NextRequestErrorHandler,
  type NextRequestErrorHandlerConfig,
} from "./request-error.js";
