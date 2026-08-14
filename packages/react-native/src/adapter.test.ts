// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { normalizeOtlpTracesEndpoint } from "./adapter.js";

describe("normalizeOtlpTracesEndpoint", () => {
  it.each([
    ["https://ingest.example", "https://ingest.example/v1/traces"],
    ["https://ingest.example/", "https://ingest.example/v1/traces"],
    ["https://ingest.example/mobile", "https://ingest.example/mobile/v1/traces"],
    ["https://ingest.example/v1/traces", "https://ingest.example/v1/traces"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeOtlpTracesEndpoint(input)).toBe(expected);
  });
});
