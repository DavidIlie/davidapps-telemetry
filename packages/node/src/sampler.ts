import type {
  Attributes,
  Context,
  Link,
  SpanKind,
} from "@opentelemetry/api";
import {
  SamplingDecision,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";

/** Runtime state understood by the provider-wide dynamic sampler. */
export interface TelemetrySamplingState {
  enabled: boolean;
  consent: "granted" | "denied" | "pending";
}

/**
 * A mutable gate around an ordinary OpenTelemetry sampler.
 *
 * OpenTelemetry providers are registered once, but consent and operational
 * switches can change later. This wrapper drops every span—including children
 * of sampled remote parents—while collection is disabled, then delegates to
 * the configured sampler immediately after collection is re-enabled.
 */
export class DynamicTelemetrySampler implements Sampler {
  #enabled: boolean;
  #consent: "granted" | "denied" | "pending";

  constructor(
    private readonly delegate: Sampler,
    state: TelemetrySamplingState,
  ) {
    this.#enabled = state.enabled;
    this.#consent = state.consent;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  setConsent(consent: "granted" | "denied" | "pending"): void {
    this.#consent = consent;
  }

  shouldSample(
    parentContext: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (!this.#enabled || this.#consent !== "granted") {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.delegate.shouldSample(
      parentContext,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
  }

  toString(): string {
    return `DynamicTelemetrySampler{${this.delegate.toString()}}`;
  }
}
