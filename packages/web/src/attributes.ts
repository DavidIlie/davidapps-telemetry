import { sanitizeAttributes } from "@davidapps/telemetry-core";
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
  return {
    ...resource.attributes,
    "service.name": resource.serviceName,
    ...(resource.serviceVersion
      ? { "service.version": resource.serviceVersion }
      : {}),
    ...(resource.environment
      ? { "deployment.environment.name": resource.environment }
      : {}),
    ...(resource.namespace ? { "service.namespace": resource.namespace } : {}),
    ...(resource.repositoryUrl
      ? { "vcs.repository.url.full": resource.repositoryUrl }
      : {}),
    ...(resource.commitSha
      ? { "vcs.ref.head.revision": resource.commitSha }
      : {}),
    ...(resource.platform ? { "deployment.platform": resource.platform } : {}),
  };
}
