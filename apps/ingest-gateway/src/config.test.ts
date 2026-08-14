import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import { configFromEnv, validateGatewayConfig } from "./config.js";

const project = {
  id: "project-one",
  hosts: ["telemetry.example.com"],
  allowedOrigins: ["https://example.com"],
  ratePerSecond: 2.5,
  burst: 10,
} as const;

const config = {
  projects: [project],
  faroUpstream: "http://alloy:12347",
  otlpUpstream: "http://alloy:4318",
  maxBodyBytes: 524_288,
  upstreamTimeoutMs: 5_000,
} as const satisfies GatewayConfig;

describe("gateway configuration", () => {
  it("accepts a complete, bounded routing policy", () => {
    expect(validateGatewayConfig(config)).toBe(config);
    expect(
      validateGatewayConfig({
        ...config,
        projects: [{ ...project, id: "native-only", allowedOrigins: [] }],
      }).projects[0]?.allowedOrigins,
    ).toEqual([]);
  });

  it("rejects malformed JSON and unknown fields", () => {
    expect(() => configFromEnv({ TELEMETRY_PROJECTS_JSON: "{" })).toThrow(/valid JSON/);
    expect(() =>
      configFromEnv({
        TELEMETRY_PROJECTS_JSON: JSON.stringify([{ ...project, ingress: { className: "external" } }]),
      }),
    ).toThrow(/unknown field ingress/);
  });

  it("rejects duplicate project IDs and case-insensitive hosts", () => {
    expect(() => validateGatewayConfig({ ...config, projects: [project, project] })).toThrow(
      /duplicate project id/,
    );
    expect(() =>
      validateGatewayConfig({
        ...config,
        projects: [project, { ...project, id: "project-two", hosts: ["TELEMETRY.EXAMPLE.COM"] }],
      }),
    ).toThrow(/duplicate host/);
  });

  it.each([
    [{ ...project, id: "Project One" }, /id must match/],
    [{ ...project, hosts: ["https://telemetry.example.com"] }, /without a scheme/],
    [{ ...project, allowedOrigins: ["https://example.com/path"] }, /only an HTTP\(S\) origin/],
    [{ ...project, ratePerSecond: 0 }, /ratePerSecond/],
    [{ ...project, burst: 1.5 }, /burst/],
    [{ ...project, allowLogs: "yes" }, /allowLogs/],
  ])("rejects an invalid project field", (invalidProject, message) => {
    expect(() =>
      validateGatewayConfig({ ...config, projects: [invalidProject as unknown as typeof project] }),
    ).toThrow(message);
  });

  it("rejects unsafe upstream URLs and non-integer numeric environment values", () => {
    expect(() => validateGatewayConfig({ ...config, otlpUpstream: "http://alloy:4318/private" })).toThrow(
      /without credentials, path/,
    );
    expect(() => configFromEnv({ MAX_BODY_BYTES: "1.5" })).toThrow(/positive integer/);
    expect(() => configFromEnv({ UPSTREAM_TIMEOUT_MS: "0" })).toThrow(/positive integer/);
  });
});
