// SPDX-License-Identifier: Apache-2.0

import {
  TelemetryClient,
  type BeforeSend,
  type TelemetryErrorHandler,
  type TelemetryResource,
} from "@davidilie/telemetry-core";
import {
  OtlpReactNativeAdapter,
  type MobileBatchConfig,
} from "./adapter.js";
import {
  installGlobalErrorHandlers,
  type GlobalErrorHandlerOptions,
} from "./errors.js";
import {
  installFetchInstrumentation,
  type FetchInstrumentationOptions,
} from "./fetch.js";
import {
  createStartupTracker,
  installAppStateTelemetry,
  type AppStateLike,
  type AppStateTelemetryOptions,
  type StartupTracker,
} from "./lifecycle.js";

export { OtlpReactNativeAdapter, normalizeOtlpTracesEndpoint } from "./adapter.js";
export type {
  MobileBatchConfig,
  OtlpReactNativeAdapterConfig,
  TraceableTelemetrySpan,
} from "./adapter.js";
export { TelemetryErrorBoundary } from "./error-boundary.js";
export type {
  TelemetryErrorBoundaryFallbackProps,
  TelemetryErrorBoundaryProps,
} from "./error-boundary.js";
export { installGlobalErrorHandlers } from "./errors.js";
export type { GlobalErrorHandlerOptions } from "./errors.js";
export { installFetchInstrumentation } from "./fetch.js";
export type { FetchInstrumentationOptions, UrlMatcher } from "./fetch.js";
export { createStartupTracker, installAppStateTelemetry } from "./lifecycle.js";
export type {
  AppStateLike,
  AppStateSubscription,
  AppStateTelemetryOptions,
  StartupTracker,
} from "./lifecycle.js";
export { createScreenTracker } from "./navigation.js";
export type { NavigationRefLike, RouteLike, ScreenTracker } from "./navigation.js";

export interface ReactNativeTelemetryConfig {
  endpoint: string;
  resource: TelemetryResource;
  /** Public routing identifier sent as `x-api-key`. It is not a secret. */
  publicKey?: string;
  headers?: Readonly<Record<string, string>>;
  batch?: MobileBatchConfig;
  enabled?: boolean;
  consent?: "granted" | "denied" | "pending";
  sampleRate?: number;
  beforeSend?: BeforeSend;
  debug?: boolean;
  onError?: TelemetryErrorHandler;
  registerGlobal?: boolean;
  /** Enabled by default. Pass false to leave global fetch untouched. */
  fetch?: false | Omit<FetchInstrumentationOptions, "ingestEndpoint">;
  /** Enabled by default. Pass false to leave global error handlers untouched. */
  errors?: false | GlobalErrorHandlerOptions;
  /** Pass React Native's `AppState` to capture transitions and flush in the background. */
  appState?: AppStateLike;
  appStateOptions?: AppStateTelemetryOptions;
  /** Defaults to SDK initialization time. */
  startupStartedAt?: number;
}

export interface ReactNativeTelemetry {
  client: TelemetryClient;
  adapter: OtlpReactNativeAdapter;
  startup: StartupTracker;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

class ReactNativeTelemetryClient extends TelemetryClient {
  constructor(
    private readonly mobileAdapter: OtlpReactNativeAdapter,
    config: ReactNativeTelemetryConfig,
  ) {
    super({
      adapter: mobileAdapter,
      resource: config.resource,
      ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
      ...(config.consent ? { consent: config.consent } : {}),
      ...(config.beforeSend ? { beforeSend: config.beforeSend } : {}),
      ...(config.debug !== undefined ? { debug: config.debug } : {}),
      ...(config.onError ? { onError: config.onError } : {}),
    });
  }

  override setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    this.mobileAdapter.setEnabled(enabled);
  }

  override setConsent(consent: "granted" | "denied" | "pending"): void {
    super.setConsent(consent);
    this.mobileAdapter.setConsent(consent);
  }
}

/**
 * Initializes a mobile OTLP trace pipeline and the small, reversible JS instrumentations.
 * Calling `shutdown` restores every global patched by this instance.
 */
export function initReactNativeTelemetry(config: ReactNativeTelemetryConfig): ReactNativeTelemetry {
  const headers = {
    ...(config.publicKey ? { "x-api-key": config.publicKey } : {}),
    ...config.headers,
  };
  const adapter = new OtlpReactNativeAdapter({
    endpoint: config.endpoint,
    resource: config.resource,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(config.batch ? { batch: config.batch } : {}),
    ...(config.sampleRate !== undefined ? { sampleRate: config.sampleRate } : {}),
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.consent ? { consent: config.consent } : {}),
    ...(config.registerGlobal !== undefined ? { registerGlobal: config.registerGlobal } : {}),
  });
  const client = new ReactNativeTelemetryClient(adapter, config);
  const teardown: Array<() => void> = [];

  if (config.fetch !== false) {
    teardown.push(
      installFetchInstrumentation(client, {
        ingestEndpoint: adapter.endpoint,
        ...config.fetch,
      }),
    );
  }
  if (config.errors !== false) {
    teardown.push(installGlobalErrorHandlers(client, config.errors));
  }
  if (config.appState) {
    teardown.push(installAppStateTelemetry(client, config.appState, config.appStateOptions));
  }

  const startup = createStartupTracker(client, config.startupStartedAt ?? Date.now());
  let stopped = false;

  return {
    client,
    adapter,
    startup,
    flush: () => client.flush(),
    async shutdown() {
      if (stopped) return;
      stopped = true;
      for (const stop of teardown.reverse()) stop();
      startup.cancel();
      await client.shutdown();
    },
  };
}

export const createReactNativeTelemetry = initReactNativeTelemetry;
