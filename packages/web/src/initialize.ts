import {
  createTelemetryClient,
  type BeforeSend,
  type TelemetryClient,
  type TelemetryResource,
} from "@davidapps/telemetry-core";
import {
  getInternalFaroFromGlobalObject,
  getWebInstrumentations,
  initializeFaro,
  type BeforeSendHook,
  type BrowserConfig,
  type Faro,
  type Instrumentation,
  type Patterns,
} from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import { FaroTelemetryAdapter } from "./adapter.js";
import { resourceAttributes, toOtelAttributes } from "./attributes.js";

type FaroOptions = Omit<
  BrowserConfig,
  "app" | "beforeSend" | "instrumentations" | "url"
>;

export interface WebTelemetryConfig extends FaroOptions {
  url: string;
  resource: TelemetryResource;
  /** Public routing identifier sent as `x-api-key`. It is not a secret. */
  publicKey?: string;
  enabled?: boolean;
  sampleRate?: number;
  consent?: "granted" | "denied" | "pending";
  debug?: boolean;
  beforeSend?: BeforeSend;
  beforeSendFaro?: BeforeSendHook;
  captureConsole?: boolean;
  enablePerformanceInstrumentation?: boolean;
  enableContentSecurityPolicyInstrumentation?: boolean;
  enableTracing?: boolean;
  tracePropagationTargets?: Patterns;
  additionalInstrumentations?: Instrumentation[];
}

export interface WebTelemetry {
  client: TelemetryClient;
  faro: Faro;
}

let activeTelemetry: WebTelemetry | undefined;

function makeApp(resource: TelemetryResource): BrowserConfig["app"] {
  return {
    name: resource.serviceName,
    ...(resource.namespace ? { namespace: resource.namespace } : {}),
    ...(resource.serviceVersion
      ? { version: resource.serviceVersion, release: resource.serviceVersion }
      : {}),
    ...(resource.environment ? { environment: resource.environment } : {}),
    ...(resource.commitSha ? { gitHash: resource.commitSha } : {}),
  };
}

function makeInstrumentations(
  config: WebTelemetryConfig,
): Instrumentation[] {
  const instrumentations = getWebInstrumentations({
    ...(config.captureConsole === undefined
      ? {}
      : { captureConsole: config.captureConsole }),
    ...(config.enablePerformanceInstrumentation === undefined
      ? {}
      : {
          enablePerformanceInstrumentation:
            config.enablePerformanceInstrumentation,
        }),
    ...(config.enableContentSecurityPolicyInstrumentation === undefined
      ? {}
      : {
          enableContentSecurityPolicyInstrumentation:
            config.enableContentSecurityPolicyInstrumentation,
        }),
  });

  if (config.enableTracing !== false) {
    instrumentations.push(
      new TracingInstrumentation({
        resourceAttributes: toOtelAttributes(resourceAttributes(config.resource)),
        ...(config.tracePropagationTargets
          ? {
              instrumentationOptions: {
                propagateTraceHeaderCorsUrls: config.tracePropagationTargets,
              },
            }
          : {}),
      }),
    );
  }

  instrumentations.push(...(config.additionalInstrumentations ?? []));
  return instrumentations;
}

function makeBrowserConfig(config: WebTelemetryConfig): BrowserConfig {
  const {
    additionalInstrumentations: _additionalInstrumentations,
    beforeSend: _beforeSend,
    beforeSendFaro,
    apiKey,
    captureConsole: _captureConsole,
    consent,
    debug: _debug,
    enabled,
    enableContentSecurityPolicyInstrumentation:
      _enableContentSecurityPolicyInstrumentation,
    enablePerformanceInstrumentation: _enablePerformanceInstrumentation,
    enableTracing: _enableTracing,
    resource,
    publicKey,
    sampleRate,
    tracePropagationTargets: _tracePropagationTargets,
    url,
    ...faroOptions
  } = config;

  const shouldSend = enabled !== false && (consent ?? "granted") === "granted";
  const sessionTracking = {
    ...faroOptions.sessionTracking,
    ...(sampleRate === undefined ? {} : { samplingRate: sampleRate }),
  };

  return {
    ...faroOptions,
    url,
    ...(publicKey ?? apiKey ? { apiKey: publicKey ?? apiKey } : {}),
    app: makeApp(resource),
    instrumentations: makeInstrumentations(config),
    ignoreUrls: [...(faroOptions.ignoreUrls ?? []), url],
    paused: Boolean(faroOptions.paused) || !shouldSend,
    ...(Object.keys(sessionTracking).length > 0 ? { sessionTracking } : {}),
    ...(beforeSendFaro ? { beforeSend: beforeSendFaro } : {}),
  };
}

export function initializeWebTelemetry(
  config: WebTelemetryConfig,
): WebTelemetry {
  if (activeTelemetry) return activeTelemetry;
  if (typeof window === "undefined") {
    throw new Error(
      "initializeWebTelemetry() is browser-only. Call it from a client entry point or effect.",
    );
  }

  const existingFaro = config.isolate
    ? undefined
    : getInternalFaroFromGlobalObject();
  const faro = existingFaro ?? initializeFaro(makeBrowserConfig(config));

  if (
    existingFaro &&
    config.enabled !== false &&
    (config.consent ?? "granted") === "granted"
  ) {
    existingFaro.unpause();
  }

  const client = createTelemetryClient({
    adapter: new FaroTelemetryAdapter(faro),
    resource: config.resource,
    ...(config.beforeSend ? { beforeSend: config.beforeSend } : {}),
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.sampleRate === undefined || config.sessionTracking?.enabled !== false
      ? {}
      : { sampleRate: config.sampleRate }),
    ...(config.consent === undefined ? {} : { consent: config.consent }),
    ...(config.debug === undefined ? {} : { debug: config.debug }),
  });

  activeTelemetry = { client, faro };
  return activeTelemetry;
}

export function getWebTelemetry(): WebTelemetry | undefined {
  return activeTelemetry;
}

export function getWebTelemetryClient(): TelemetryClient | undefined {
  return activeTelemetry?.client;
}

export async function shutdownWebTelemetry(): Promise<void> {
  const current = activeTelemetry;
  activeTelemetry = undefined;
  await current?.client.shutdown();
}
