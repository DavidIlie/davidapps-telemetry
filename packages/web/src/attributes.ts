import {
  sanitizeAttributes,
  sanitizeResource,
} from "@davidapps/telemetry-core";
import type {
  Attributes,
  AttributeValue,
  TelemetryResource,
} from "@davidapps/telemetry-core";

type OtelAttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

function stringifyAttribute(value: AttributeValue): string {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function normalizeOtelAttribute(value: AttributeValue): OtelAttributeValue {
  if (typeof value !== "object") return value;
  if (value.every((entry) => typeof entry === "string")) return [...value] as string[];
  if (value.every((entry) => typeof entry === "number")) return [...value] as number[];
  if (value.every((entry) => typeof entry === "boolean")) return [...value] as boolean[];
  return JSON.stringify(value);
}

export function toStringAttributes(attributes: Attributes): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sanitizeAttributes(attributes)).map(([key, value]) => [
      key,
      stringifyAttribute(value),
    ]),
  );
}

export function toOtelAttributes(
  attributes: Attributes,
): Record<string, OtelAttributeValue> {
  return Object.fromEntries(
    Object.entries(sanitizeAttributes(attributes)).map(([key, value]) => [
      key,
      normalizeOtelAttribute(value),
    ]),
  );
}

export function resourceAttributes(resource: TelemetryResource): Attributes {
  const clean = sanitizeResource(resource);
  return {
    ...clean.attributes,
    "service.name": clean.serviceName,
    ...(clean.serviceVersion
      ? { "service.version": clean.serviceVersion }
      : {}),
    ...(clean.environment
      ? { "deployment.environment.name": clean.environment }
      : {}),
    ...(clean.namespace ? { "service.namespace": clean.namespace } : {}),
    ...(clean.repositoryUrl
      ? { "vcs.repository.url.full": clean.repositoryUrl }
      : {}),
    ...(clean.commitSha
      ? { "vcs.ref.head.revision": clean.commitSha }
      : {}),
    ...(clean.platform ? { "deployment.platform": clean.platform } : {}),
  };
}

/** Convert already-sanitized, trusted resource identity without dropping it. */
export function toOtelResourceAttributes(
  resource: TelemetryResource,
): Record<string, OtelAttributeValue> {
  return Object.fromEntries(
    Object.entries(resourceAttributes(resource)).flatMap(([key, value]) =>
      value == null ? [] : [[key, normalizeOtelAttribute(value)]],
    ),
  );
}

/** String form used by Faro event/log/measurement contexts. */
export function toStringResourceAttributes(
  resource: TelemetryResource,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(resourceAttributes(resource)).flatMap(([key, value]) =>
      value == null ? [] : [[key, stringifyAttribute(value)]],
    ),
  );
}
