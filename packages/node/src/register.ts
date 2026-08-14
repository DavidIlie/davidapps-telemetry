import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  NodeSDK,
  type NodeSDKConfiguration,
} from "@opentelemetry/sdk-node";
import {
  NodeTelemetryClient,
  type NodeTelemetryConfig,
} from "./client.js";
import { telemetryResourceAttributes } from "./attributes.js";

const REGISTRATION = Symbol.for("@davidapps/telemetry-node/registration");

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

export function registerNodeTelemetry(
  config: RegisterNodeTelemetryConfig,
): NodeTelemetryClient {
  const sharedGlobal = globalThis as GlobalWithRegistration;
  const existing = sharedGlobal[REGISTRATION];
  if (existing) return existing.client;

  const sdk = new NodeSDK({
    ...config.sdk,
    resource: resourceFromAttributes(
      telemetryResourceAttributes(config.resource),
    ),
    serviceName: config.resource.serviceName,
  });
  sdk.start();

  let client: NodeTelemetryClient;
  client = new NodeTelemetryClient({
    ...config,
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
