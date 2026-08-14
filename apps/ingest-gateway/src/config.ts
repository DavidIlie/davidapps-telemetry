import { isIP } from "node:net";

export interface GatewayProject {
  id: string;
  hosts: readonly string[];
  allowedOrigins: readonly string[];
  publicKey?: string;
  ratePerSecond?: number;
  burst?: number;
  allowFaro?: boolean;
  allowTraces?: boolean;
  allowLogs?: boolean;
  allowMetrics?: boolean;
}

export interface GatewayConfig {
  projects: readonly GatewayProject[];
  faroUpstream: string;
  otlpUpstream: string;
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
}

const PROJECT_KEYS = new Set([
  "id",
  "hosts",
  "allowedOrigins",
  "publicKey",
  "ratePerSecond",
  "burst",
  "allowFaro",
  "allowTraces",
  "allowLogs",
  "allowMetrics",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HOST_LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function fail(message: string): never {
  throw new Error(`Invalid telemetry gateway configuration: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, field: string, maxLength = 2_048): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    fail(`${field} must be a non-empty, trimmed string of at most ${maxLength} characters`);
  }
}

function assertStringArray(value: unknown, field: string, allowEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${field} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  for (const [index, item] of value.entries()) assertNonEmptyString(item, `${field}[${index}]`);
}

function assertOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") fail(`${field} must be a boolean`);
}

function assertPositiveNumber(value: unknown, field: string, integer = false): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    fail(`${field} must be a positive${integer ? " integer" : " finite number"}`);
  }
}

function canonicalHost(value: string, field: string): string {
  const host = value.toLowerCase().replace(/\.$/, "");
  if (host !== value.toLowerCase() || host.length > 253) {
    fail(`${field} must be a hostname without a trailing dot`);
  }
  if (host !== "localhost" && isIP(host) === 0 && !host.split(".").every((label) => HOST_LABEL_PATTERN.test(label))) {
    fail(`${field} must be a hostname without a scheme, port, or path`);
  }
  return host;
}

function assertOrigin(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} must be an absolute HTTP(S) origin`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    fail(`${field} must contain only an HTTP(S) origin (no path, credentials, query, or fragment)`);
  }
}

function assertUpstream(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} must be an absolute HTTP(S) URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    fail(`${field} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
}

function parseProjects(value: string | undefined): GatewayProject[] {
  if (!value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("TELEMETRY_PROJECTS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) fail("TELEMETRY_PROJECTS_JSON must be an array");

  return parsed.map((item, index) => {
    if (!isRecord(item)) fail(`projects[${index}] must be an object`);
    const unknownKey = Object.keys(item).find((key) => !PROJECT_KEYS.has(key));
    if (unknownKey) fail(`projects[${index}] contains unknown field ${unknownKey}`);
    return item as unknown as GatewayProject;
  });
}

/**
 * Fail fast before the server binds. A typo in routing policy must never turn
 * into a silently broader public ingest endpoint.
 */
export function validateGatewayConfig(config: GatewayConfig): GatewayConfig {
  if (!Array.isArray(config.projects)) fail("projects must be an array");
  assertUpstream(config.faroUpstream, "faroUpstream");
  assertUpstream(config.otlpUpstream, "otlpUpstream");
  assertPositiveNumber(config.maxBodyBytes, "maxBodyBytes", true);
  assertPositiveNumber(config.upstreamTimeoutMs, "upstreamTimeoutMs", true);

  const projectIds = new Set<string>();
  const hosts = new Set<string>();

  for (const [index, project] of config.projects.entries()) {
    const prefix = `projects[${index}]`;
    if (!isRecord(project)) fail(`${prefix} must be an object`);
    assertNonEmptyString(project.id, `${prefix}.id`, 63);
    if (!PROJECT_ID_PATTERN.test(project.id)) {
      fail(`${prefix}.id must match ${PROJECT_ID_PATTERN}`);
    }
    if (projectIds.has(project.id)) fail(`duplicate project id ${project.id}`);
    projectIds.add(project.id);

    assertStringArray(project.hosts, `${prefix}.hosts`);
    for (const [hostIndex, configuredHost] of project.hosts.entries()) {
      const host = canonicalHost(configuredHost, `${prefix}.hosts[${hostIndex}]`);
      if (hosts.has(host)) fail(`duplicate host ${host}`);
      hosts.add(host);
    }

    // An empty list is valid for native/server-only ingestion, which does not
    // send Origin. It intentionally prevents every browser origin.
    assertStringArray(project.allowedOrigins, `${prefix}.allowedOrigins`, true);
    const origins = new Set<string>();
    for (const [originIndex, origin] of project.allowedOrigins.entries()) {
      assertOrigin(origin, `${prefix}.allowedOrigins[${originIndex}]`);
      if (origins.has(origin)) fail(`duplicate origin ${origin} in project ${project.id}`);
      origins.add(origin);
    }

    if (project.publicKey !== undefined) {
      assertNonEmptyString(project.publicKey, `${prefix}.publicKey`, 256);
    }
    if (project.ratePerSecond !== undefined) {
      assertPositiveNumber(project.ratePerSecond, `${prefix}.ratePerSecond`);
    }
    if (project.burst !== undefined) assertPositiveNumber(project.burst, `${prefix}.burst`, true);
    assertOptionalBoolean(project.allowFaro, `${prefix}.allowFaro`);
    assertOptionalBoolean(project.allowTraces, `${prefix}.allowTraces`);
    assertOptionalBoolean(project.allowLogs, `${prefix}.allowLogs`);
    assertOptionalBoolean(project.allowMetrics, `${prefix}.allowMetrics`);
  }

  return config;
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) fail(`${field} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${field} must be a safe positive integer`);
  return parsed;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return validateGatewayConfig({
    projects: parseProjects(env.TELEMETRY_PROJECTS_JSON),
    faroUpstream: env.ALLOY_FARO_URL ?? "http://alloy.observability.svc.cluster.local:12347",
    otlpUpstream: env.ALLOY_OTLP_URL ?? "http://alloy.observability.svc.cluster.local:4318",
    maxBodyBytes: positiveIntegerFromEnv(env.MAX_BODY_BYTES, 524_288, "MAX_BODY_BYTES"),
    upstreamTimeoutMs: positiveIntegerFromEnv(env.UPSTREAM_TIMEOUT_MS, 5_000, "UPSTREAM_TIMEOUT_MS"),
  });
}
