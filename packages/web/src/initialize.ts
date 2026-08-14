import {
  createTelemetryClient,
  sanitizeResource,
  type BeforeSend,
  type TelemetryClient,
  type TelemetryErrorHandler,
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
import { toOtelResourceAttributes } from "./attributes.js";
import { createPrivacyBeforeSend } from "./privacy.js";

type FaroOptions = Omit<
  BrowserConfig,
  | "apiKey"
  | "app"
  | "beforeSend"
  | "instrumentations"
  | "metas"
  | "preserveOriginalError"
  | "trackGeolocation"
  | "url"
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
  onError?: TelemetryErrorHandler;
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
  /** Pause/unpause both custom and automatic Faro signals. */
  setEnabled(enabled: boolean): void;
  /** Pause Faro unless consent is explicitly granted. */
  setConsent(consent: "granted" | "denied" | "pending"): void;
  /** Pause collection and shut down the core client once. */
  shutdown(): Promise<void>;
}

let activeTelemetry: WebTelemetry | undefined;
let activeFingerprint: string | undefined;

function fingerprint(config: WebTelemetryConfig): string {
  return JSON.stringify({
    url: config.url,
    publicKey: config.publicKey,
    isolate: config.isolate ?? false,
    resource: config.resource,
  });
}

function normalizeSampleRate(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

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
        resourceAttributes: toOtelResourceAttributes(config.resource),
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
    onError: _onError,
    sampleRate,
    tracePropagationTargets: _tracePropagationTargets,
    url,
    ...faroOptions
  } = config;

  const shouldSend = enabled !== false && (consent ?? "granted") === "granted";
  const normalizedSampleRate = normalizeSampleRate(sampleRate);
  const sessionTracking = {
    ...faroOptions.sessionTracking,
    ...(normalizedSampleRate === undefined
      ? {}
      : { samplingRate: normalizedSampleRate }),
  };

  return {
    ...faroOptions,
    url,
    ...(publicKey ? { apiKey: publicKey } : {}),
    app: makeApp(resource),
    instrumentations: makeInstrumentations(config),
    ignoreUrls: [...(faroOptions.ignoreUrls ?? []), url],
    paused: Boolean(faroOptions.paused) || !shouldSend,
    ...(Object.keys(sessionTracking).length > 0 ? { sessionTracking } : {}),
    beforeSend: createPrivacyBeforeSend(beforeSendFaro),
  };
}

export function initializeWebTelemetry(
  config: WebTelemetryConfig,
): WebTelemetry {
  const cleanConfig: WebTelemetryConfig = {
    ...config,
    resource: sanitizeResource(config.resource),
  };
  const requestedFingerprint = fingerprint(cleanConfig);
  if (activeTelemetry) {
    if (activeFingerprint !== requestedFingerprint) {
      throw new Error(
        "Web telemetry is already initialized with different routing or resource identity",
      );
    }
    return activeTelemetry;
  }
  if (typeof window === "undefined") {
    throw new Error(
      "initializeWebTelemetry() is browser-only. Call it from a client entry point or effect.",
    );
  }

  const existingFaro = cleanConfig.isolate
    ? undefined
    : getInternalFaroFromGlobalObject();
  if (existingFaro) {
    throw new Error(
      "A global Faro instance already exists. Initialize this package first or pass isolate: true so routing and privacy settings cannot be stale.",
    );
  }
  const faro = initializeFaro(makeBrowserConfig(cleanConfig));

  const client = createTelemetryClient({
    adapter: new FaroTelemetryAdapter(faro),
    resource: cleanConfig.resource,
    ...(cleanConfig.beforeSend ? { beforeSend: cleanConfig.beforeSend } : {}),
    ...(cleanConfig.enabled === undefined ? {} : { enabled: cleanConfig.enabled }),
    ...(cleanConfig.sampleRate === undefined || cleanConfig.sessionTracking?.enabled !== false
      ? {}
      : { sampleRate: cleanConfig.sampleRate }),
    ...(cleanConfig.consent === undefined ? {} : { consent: cleanConfig.consent }),
    ...(cleanConfig.debug === undefined ? {} : { debug: cleanConfig.debug }),
    ...(cleanConfig.onError ? { onError: cleanConfig.onError } : {}),
  });

  let enabled = cleanConfig.enabled ?? true;
  let consent = cleanConfig.consent ?? "granted";
  let stopped = false;
  const synchronizeFaro = () => {
    if (!stopped && enabled && consent === "granted") faro.unpause();
    else faro.pause();
  };
  const telemetry: WebTelemetry = {
    client,
    faro,
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
      client.setEnabled(nextEnabled);
      synchronizeFaro();
    },
    setConsent(nextConsent) {
      consent = nextConsent;
      client.setConsent(nextConsent);
      synchronizeFaro();
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      synchronizeFaro();
      if (activeTelemetry === telemetry) {
        activeTelemetry = undefined;
        activeFingerprint = undefined;
      }
      await client.shutdown();
    },
  };
  activeTelemetry = telemetry;
  activeFingerprint = requestedFingerprint;
  return activeTelemetry;
}

export function getWebTelemetry(): WebTelemetry | undefined {
  return activeTelemetry;
}

export function getWebTelemetryClient(): TelemetryClient | undefined {
  return activeTelemetry?.client;
}

export async function shutdownWebTelemetry(): Promise<void> {
  await activeTelemetry?.shutdown();
}
