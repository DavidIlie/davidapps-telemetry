import {
  TelemetryClient,
  type Attributes,
  type BeforeSend,
  type TelemetryResource,
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
}

export interface NodeTelemetryInternalConfig extends NodeTelemetryConfig {
  shutdown?: OpenTelemetryAdapterConfig["shutdown"];
}

export class NodeTelemetryClient extends TelemetryClient {
  readonly #adapter: OpenTelemetryAdapter;
  readonly #sampleRate: number;
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
      ...(config.shutdown ? { shutdown: config.shutdown } : {}),
    });

    super({
      adapter,
      resource: config.resource,
      ...(config.beforeSend ? { beforeSend: config.beforeSend } : {}),
      ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
      ...(config.sampleRate !== undefined
        ? { sampleRate: config.sampleRate }
        : {}),
      ...(config.consent ? { consent: config.consent } : {}),
      ...(config.debug !== undefined ? { debug: config.debug } : {}),
    });

    this.#adapter = adapter;
    this.#sampleRate = Math.min(1, Math.max(0, config.sampleRate ?? 1));
    this.#enabled = config.enabled ?? true;
    this.#consent = config.consent ?? "granted";
  }

  override setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    super.setEnabled(enabled);
  }

  override setConsent(consent: "granted" | "denied" | "pending"): void {
    this.#consent = consent;
    super.setConsent(consent);
  }

  override async withSpan<T>(
    name: string,
    operation: () => T | Promise<T>,
    attributes: Attributes = {},
  ): Promise<T> {
    if (
      !this.#enabled ||
      this.#consent !== "granted" ||
      Math.random() > this.#sampleRate
    ) {
      return operation();
    }

    return this.#adapter.withActiveSpan(name, operation, attributes);
  }
}

export function createNodeTelemetry(
  config: NodeTelemetryConfig,
): NodeTelemetryClient {
  return new NodeTelemetryClient(config);
}
