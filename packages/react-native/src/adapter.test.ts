// SPDX-License-Identifier: Apache-2.0

import { context, SpanKind } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  SamplingDecision,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  MobileCollectionSampler,
  normalizeOtlpTracesEndpoint,
} from "./adapter.js";

describe("normalizeOtlpTracesEndpoint", () => {
  it.each([
    ["https://ingest.example", "https://ingest.example/v1/traces"],
    ["https://ingest.example/", "https://ingest.example/v1/traces"],
    ["https://ingest.example/mobile", "https://ingest.example/mobile/v1/traces"],
    ["https://ingest.example/v1/traces", "https://ingest.example/v1/traces"],
    [
      "https://ingest.example/mobile?token=public-routing#fragment",
      "https://ingest.example/mobile/v1/traces",
    ],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeOtlpTracesEndpoint(input)).toBe(expected);
  });

  it.each([
    "ftp://ingest.example",
    "https://user:password@ingest.example",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => normalizeOtlpTracesEndpoint(endpoint)).toThrow();
  });

  it("updates provider-wide collection when consent changes", () => {
    const sampler = new MobileCollectionSampler(
      new AlwaysOnSampler(),
      true,
      "pending",
    );
    const decide = () =>
      sampler.shouldSample(
        context.active(),
        "0123456789abcdef0123456789abcdef",
        "third-party-span",
        SpanKind.INTERNAL,
        {},
        [],
      ).decision;

    expect(decide()).toBe(SamplingDecision.NOT_RECORD);
    sampler.setConsent("granted");
    expect(decide()).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    sampler.setEnabled(false);
    expect(decide()).toBe(SamplingDecision.NOT_RECORD);
  });
});
