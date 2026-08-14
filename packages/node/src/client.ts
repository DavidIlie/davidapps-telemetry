import {
  redactText,
  sanitizeAttributes,
  TelemetryClient,
  type Attributes,
  type BeforeSend,
  type TelemetryErrorContext,
  type TelemetryErrorHandler,
  type TelemetryResource,
  type TelemetrySpanOptions,
} from "@davidapps/telemetry-core";
import {
  OpenTelemetryAdapter,
  type OpenTelemetryAdapterConfig,
} from "./adapter.js";

export interface NodeTelemetryConfig {
  resource: TelemetryResource;
  beforeSend?: BeforeSend;
  enabled?: boolean;
  sampleRate?: number;
  consent?: "granted" | "denied" | "pending";
  debug?: boolean;
  instrumentationName?: string;
  instrumentationVersion?: string;
  /**
   * Write JSON logs to stdout/stderr for Kubernetes log collection. Defaults
   * to true. Set false when OTLP logs are the sole desired path.
   */
  structuredConsole?: boolean;
  /** Export measurements as trace spans, OTEL metrics, or both. */
  measurementMode?: OpenTelemetryAdapterConfig["measurementMode"];
  /** Low-cardinality application attributes permitted on metric points. */
  metricAttributeAllowlist?: readonly string[];
  /** Maximum distinct histogram name/unit pairs created by this client. */
  maxMetricInstruments?: number;
  /** Receives telemetry failures; handler failures are also contained. */
  onError?: TelemetryErrorHandler;
}

export interface NodeTelemetryInternalConfig extends NodeTelemetryConfig {
  shutdown?: OpenTelemetryAdapterConfig["shutdown"];
  /** Provider registration owns trace sampling; avoid sampling spans twice. */
  providerManagedSampling?: boolean;
  onCollectionStateChange?: (state: {
    enabled: boolean;
    consent: "granted" | "denied" | "pending";
  }) => void;
}

export class NodeTelemetryClient extends TelemetryClient {
  readonly #adapter: OpenTelemetryAdapter;
  readonly #sampleRate: number;
  readonly #onError: TelemetryErrorHandler | undefined;
  readonly #onCollectionStateChange:
    | NodeTelemetryInternalConfig["onCollectionStateChange"]
    | undefined;
  #enabled: boolean;
  #consent: "granted" | "denied" | "pending";

  constructor(config: NodeTelemetryInternalConfig) {
    const adapter = new OpenTelemetryAdapter({
      resource: config.resource,
      ...(config.instrumentationName
        ? { instrumentationName: config.instrumentationName }
        : {}),
      ...(config.instrumentationVersion
        ? { instrumentationVersion: config.instrumentationVersion }
        : {}),
      ...(config.structuredConsole !== undefined
        ? { structuredConsole: config.structuredConsole }
        : {}),
      ...(config.measurementMode
        ? { measurementMode: config.measurementMode }
        : {}),
      ...(config.metricAttributeAllowlist
        ? { metricAttributeAllowlist: config.metricAttributeAllowlist }
        : {}),
      ...(config.maxMetricInstruments !== undefined
        ? { maxMetricInstruments: config.maxMetricInstruments }
        : {}),
      ...(config.providerManagedSampling
        ? { logSampleRate: config.sampleRate }
        : {}),
      ...(config.shutdown ? { shutdown: config.shutdown } : {}),
    });

    super({
      adapter,
      resource: config.resource,
      ...(config.beforeSend ? { beforeSend: config.beforeSend } : {}),
      ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
      ...(config.sampleRate !== undefined
        ? {
            sampleRate: config.providerManagedSampling
              ? 1
              : config.sampleRate,
          }
        : {}),
      ...(config.consent ? { consent: config.consent } : {}),
      ...(config.debug !== undefined ? { debug: config.debug } : {}),
      ...(config.onError ? { onError: config.onError } : {}),
    });

    this.#adapter = adapter;
    this.#sampleRate = config.providerManagedSampling
      ? 1
      : Number.isFinite(config.sampleRate)
        ? Math.min(1, Math.max(0, config.sampleRate ?? 1))
        : 1;
    this.#onError = config.onError;
    this.#onCollectionStateChange = config.onCollectionStateChange;
    this.#enabled = config.enabled ?? true;
    this.#consent = config.consent ?? "granted";
  }

  override setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    super.setEnabled(enabled);
    this.#onCollectionStateChange?.({
      enabled: this.#enabled,
      consent: this.#consent,
    });
  }

  override setConsent(consent: "granted" | "denied" | "pending"): void {
    this.#consent = consent;
    super.setConsent(consent);
    this.#onCollectionStateChange?.({
      enabled: this.#enabled,
      consent: this.#consent,
    });
  }

  override async withSpan<T>(
    name: string,
    operation: () => T | Promise<T>,
    attributes: Attributes = {},
    options: TelemetrySpanOptions = {},
  ): Promise<T> {
    if (
      !this.#enabled ||
      this.#consent !== "granted" ||
      Math.random() >= this.#sampleRate
    ) {
      return operation();
    }

    let operationStarted = false;
    try {
      return await this.#adapter.withActiveSpan(
        redactText(name, 256),
        () => {
          operationStarted = true;
          return operation();
        },
        sanitizeAttributes(attributes),
        options,
      );
    } catch (error) {
      if (operationStarted) throw error;
      this.#reportAdapterError(error, { operation: "startSpan" });
      return operation();
    }
  }

  #reportAdapterError(error: unknown, context: TelemetryErrorContext): void {
    if (!this.#onError) return;
    try {
      void Promise.resolve(this.#onError(error, context)).catch(() => undefined);
    } catch {
      // Diagnostics must remain fail-open too.
    }
  }
}

export function createNodeTelemetry(
  config: NodeTelemetryConfig,
): NodeTelemetryClient {
  return new NodeTelemetryClient(config);
}
