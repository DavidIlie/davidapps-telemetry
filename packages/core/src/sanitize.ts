import type {
  Attributes,
  AttributeValue,
  TelemetryResource,
  TelemetrySignal,
} from "./types.js";

const SENSITIVE_KEY = /(?:^|[._-])(?:authorization|proxy[._-]?authorization|cookie|set[._-]?cookie|password|passwd|secret|api[._-]?key|apikey|access[._-]?token|refresh[._-]?token|id[._-]?token|auth[._-]?token|session[._-]?token|request[._-]?body|response[._-]?body|email|e[._-]?mail|phone|user[._-]?(?:id|name|full[._-]?name)|account[._-]?id|customer[._-]?id)(?:$|[._-])/i;
const EXACT_SENSITIVE_KEY = /^(?:token|body|headers?|ip|ip_address|client_address)$/i;
const STANDARD_DIRECT_IDENTIFIER_KEY = /^(?:enduser\.(?:id|email)|user\.(?:id|email|name|full_name)|device\.id)$/i;
const RESERVED_RESOURCE_KEY = /^(?:service\.(?:name|version|namespace)|deployment\.(?:environment(?:\.name)?|platform)|vcs\.(?:repository\.url\.full|ref\.head\.revision)|app\.(?:repository\.url|platform)|mobile\.platform)$/i;
const URL_KEY = /(?:^|[._-])(?:url|uri|href)(?:$|[._-])|^(?:http\.target|http\.url)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;
const AUTH_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const ASSIGNED_SECRET = /\b(api[ _-]?key|token|access[ _-]?token|refresh[ _-]?token|password|passwd|secret)\b\s*[:=]\s*([^\s,;]+)/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const MAX_ATTRIBUTE_COUNT = 64;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 2_048;
const MAX_STACK_LENGTH = 16_384;
const MAX_ARRAY_LENGTH = 32;
const MAX_NAME_LENGTH = 256;

/** Returns true for secret, direct-identifier, body, header, or reserved identity keys. */
export function isSensitiveAttributeKey(key: string): boolean {
  return (
    SENSITIVE_KEY.test(key) ||
    EXACT_SENSITIVE_KEY.test(key) ||
    STANDARD_DIRECT_IDENTIFIER_KEY.test(key) ||
    RESERVED_RESOURCE_KEY.test(key)
  );
}

/** Remove credentials, query parameters, and fragments from an absolute or relative URL. */
export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "";
  }
}

/**
 * Best-effort value redaction for messages and exception text.
 *
 * This is a safety net, not a reason to send request bodies or direct user
 * identifiers. Applications should still emit deliberately safe messages.
 */
export function redactText(value: string, maxLength = MAX_VALUE_LENGTH): string {
  return value
    .replace(URL_IN_TEXT, (url) => sanitizeUrl(url))
    .replace(AUTH_VALUE, "$1 [REDACTED]")
    .replace(ASSIGNED_SECRET, "$1=[REDACTED]")
    .replace(JWT_VALUE, "[REDACTED_JWT]")
    .replace(EMAIL_VALUE, "[REDACTED_EMAIL]")
    .slice(0, maxLength);
}

function sanitizeString(key: string, value: string): string {
  const redacted = redactText(value);
  return URL_KEY.test(key) ? sanitizeUrl(redacted).slice(0, MAX_VALUE_LENGTH) : redacted;
}

function sanitizeValue(key: string, value: AttributeValue): AttributeValue {
  if (typeof value === "string") return sanitizeString(key, value);
  if (!Array.isArray(value)) return value;

  return value.slice(0, MAX_ARRAY_LENGTH).map((entry) =>
    typeof entry === "string" ? sanitizeString(key, entry) : entry,
  );
}

/**
 * Copy and sanitize attributes using the invariant shared by every adapter.
 *
 * Safe analytics such as `input_tokens` and `output_tokens` are retained;
 * credential-bearing keys such as `access_token` are removed.
 */
export function sanitizeAttributes(attributes: Attributes = {}): Record<string, AttributeValue> {
  const sanitized: Record<string, AttributeValue> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (Object.keys(sanitized).length >= MAX_ATTRIBUTE_COUNT) break;
    if (
      value == null ||
      key.length === 0 ||
      key.length > MAX_KEY_LENGTH ||
      isSensitiveAttributeKey(key)
    ) {
      continue;
    }

    sanitized[key] = sanitizeValue(key, value);
  }

  return sanitized;
}

function cleanIdentity(value: string | undefined, maxLength = MAX_NAME_LENGTH): string | undefined {
  if (!value) return undefined;
  const clean = redactText(value.trim(), maxLength);
  return clean || undefined;
}

/** Copy, normalize, and sanitize stable resource identity. */
export function sanitizeResource(resource: TelemetryResource): TelemetryResource {
  const serviceName = cleanIdentity(resource.serviceName);
  if (!serviceName) throw new Error("Telemetry resource.serviceName is required");

  const serviceVersion = cleanIdentity(resource.serviceVersion);
  const environment = cleanIdentity(resource.environment, 128);
  const namespace = cleanIdentity(resource.namespace);
  const repositoryUrl = resource.repositoryUrl
    ? sanitizeUrl(redactText(resource.repositoryUrl)).slice(0, MAX_VALUE_LENGTH)
    : undefined;
  const commitSha = cleanIdentity(resource.commitSha, 128);
  const platform = cleanIdentity(resource.platform, 128);

  return {
    serviceName,
    ...(serviceVersion ? { serviceVersion } : {}),
    ...(environment ? { environment } : {}),
    ...(namespace ? { namespace } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(platform ? { platform } : {}),
    attributes: sanitizeAttributes(resource.attributes),
  };
}

/** Reapply privacy and size invariants to a complete signal. */
export function sanitizeSignal(signal: TelemetrySignal): TelemetrySignal {
  const common = {
    ...signal,
    resource: sanitizeResource(signal.resource),
    attributes: sanitizeAttributes(signal.attributes),
  };

  switch (signal.type) {
    case "exception":
      return {
        ...common,
        type: "exception",
        exception: {
          name: redactText(signal.exception.name, MAX_NAME_LENGTH),
          message: redactText(signal.exception.message),
          ...(signal.exception.stack
            ? { stack: redactText(signal.exception.stack, MAX_STACK_LENGTH) }
            : {}),
          ...(signal.exception.cause
            ? { cause: redactText(signal.exception.cause) }
            : {}),
        },
      };
    case "log":
      return {
        ...common,
        type: "log",
        level: signal.level,
        message: redactText(signal.message),
      };
    case "event":
      return { ...common, type: "event", name: redactText(signal.name, MAX_NAME_LENGTH) };
    case "measurement":
      return {
        ...common,
        type: "measurement",
        name: redactText(signal.name, MAX_NAME_LENGTH),
        value: signal.value,
        ...(signal.unit ? { unit: redactText(signal.unit, 64) } : {}),
      };
  }
}
