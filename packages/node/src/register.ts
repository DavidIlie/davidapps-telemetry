import { resourceFromAttributes } from "@opentelemetry/resources";
import { sanitizeResource } from "@davidilie/telemetry-core";
import {
  NodeSDK,
  type NodeSDKConfiguration,
} from "@opentelemetry/sdk-node";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  NodeTelemetryClient,
  type NodeTelemetryConfig,
} from "./client.js";
import { telemetryResourceAttributes } from "./attributes.js";
import { DynamicTelemetrySampler } from "./sampler.js";

const REGISTRATION = Symbol.for("@davidilie/telemetry-node/registration");

interface RegisteredNodeTelemetry {
  client: NodeTelemetryClient;
  sdk: NodeSDK;
}

type GlobalWithRegistration = typeof globalThis & {
  [REGISTRATION]?: RegisteredNodeTelemetry;
};

export interface RegisterNodeTelemetryConfig extends NodeTelemetryConfig {
  sdk?: Omit<
    Partial<NodeSDKConfiguration>,
    "resource" | "serviceName"
  >;
}

function traceSampleRate(config: NodeTelemetryConfig): number {
  if (!Number.isFinite(config.sampleRate)) return 1;
  return Math.min(1, Math.max(0, config.sampleRate ?? 1));
}

export function registerNodeTelemetry(
  config: RegisterNodeTelemetryConfig,
): NodeTelemetryClient {
  const sharedGlobal = globalThis as GlobalWithRegistration;
  const existing = sharedGlobal[REGISTRATION];
  if (existing) return existing.client;
  const resource = sanitizeResource(config.resource);

  const sampler = new DynamicTelemetrySampler(
    config.sdk?.sampler ??
      new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(traceSampleRate(config)),
      }),
    {
      enabled: config.enabled ?? true,
      consent: config.consent ?? "granted",
    },
  );

  const sdk = new NodeSDK({
    ...config.sdk,
    sampler,
    resource: resourceFromAttributes(
      telemetryResourceAttributes(resource),
    ),
    serviceName: resource.serviceName,
  });
  sdk.start();

  let client: NodeTelemetryClient;
  client = new NodeTelemetryClient({
    ...config,
    resource,
    // The registered SDK sampler owns spans. The adapter still applies the
    // configured rate once to logs, which have no trace sampler.
    providerManagedSampling: true,
    onCollectionStateChange: (state) => {
      sampler.setEnabled(state.enabled);
      sampler.setConsent(state.consent);
    },
    measurementMode:
      config.measurementMode ??
      (config.sdk?.metricReaders?.length ? "metrics" : "spans"),
    shutdown: async () => {
      await sdk.shutdown();
      if (sharedGlobal[REGISTRATION]?.client === client) {
        delete sharedGlobal[REGISTRATION];
      }
    },
  });

  sharedGlobal[REGISTRATION] = { client, sdk };
  return client;
}

export const register = registerNodeTelemetry;

export type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
