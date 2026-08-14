import type {
  Attributes as DavidAppsAttributes,
  AttributeValue as DavidAppsAttributeValue,
  TelemetryResource,
} from "@davidapps/telemetry-core";
import type {
  Attributes as OtelAttributes,
  AttributeValue as OtelAttributeValue,
} from "@opentelemetry/api";

export function toOtelAttributeValue(
  value: DavidAppsAttributeValue,
): OtelAttributeValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value.every((entry): entry is string => typeof entry === "string")) {
    return [...value];
  }
  if (value.every((entry): entry is number => typeof entry === "number")) {
    return [...value];
  }
  if (value.every((entry): entry is boolean => typeof entry === "boolean")) {
    return [...value];
  }

  // OpenTelemetry arrays must be homogeneous. The shared contract permits a
  // mixed primitive array, so preserve it deterministically as strings.
  return value.map(String);
}

export function toOtelAttributes(
  attributes: DavidAppsAttributes = {},
): OtelAttributes {
  const result: OtelAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    result[key] = toOtelAttributeValue(value);
  }

  return result;
}

export function telemetryResourceAttributes(
  resource: TelemetryResource,
): OtelAttributes {
  return {
    "service.name": resource.serviceName,
    ...(resource.serviceVersion
      ? { "service.version": resource.serviceVersion }
      : {}),
    ...(resource.environment
      ? { "deployment.environment.name": resource.environment }
      : {}),
    ...(resource.namespace
      ? { "service.namespace": resource.namespace }
      : {}),
    ...(resource.repositoryUrl
      ? {
          "app.repository.url": resource.repositoryUrl,
          "vcs.repository.url.full": resource.repositoryUrl,
        }
      : {}),
    ...(resource.commitSha
      ? { "vcs.ref.head.revision": resource.commitSha }
      : {}),
    ...(resource.platform ? { "app.platform": resource.platform } : {}),
    ...toOtelAttributes(resource.attributes),
  };
}
