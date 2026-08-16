import {
  isSensitiveAttributeKey,
  redactText,
  sanitizeUrl,
} from "@davidilie/telemetry-core";
import type {
  BeforeSendHook,
  TransportItem,
} from "@grafana/faro-web-sdk";

const URL_KEY = /(?:^|[._-])(?:url|uri|href|filename)(?:$|[._-])|^(?:http\.target|http\.url)$/i;
// Rebuilt plain objects must never be assigned these keys: the assignment hits
// the legacy __proto__ setter or shadows the constructor instead of becoming an
// ordinary own property. They are never legitimate telemetry payload keys.
const FORBIDDEN_PAYLOAD_KEY = /^(?:__proto__|prototype|constructor)$/;
const PROTECTED_RESOURCE_KEY = /^(?:service\.(?:name|version|namespace)|deployment\.(?:environment(?:\.name)?|platform)|vcs\.(?:repository\.url\.full|ref\.head\.revision)|app\.(?:repository\.url|platform)|mobile\.platform)$/i;
const DIRECT_IDENTIFIER_KEY = /^(?:enduser\.(?:id|email)|user\.(?:id|email|name|full_name)|device\.id)$/i;
const MAX_DEPTH = 24;

function shouldDropKey(key: string): boolean {
  return (
    !PROTECTED_RESOURCE_KEY.test(key) &&
    (DIRECT_IDENTIFIER_KEY.test(key) || isSensitiveAttributeKey(key))
  );
}

function sanitizeString(key: string, value: string): string {
  const redacted = redactText(value, key === "stack" ? 16_384 : 2_048);
  return URL_KEY.test(key) ? sanitizeUrl(redacted) : redacted;
}

function sanitizeOtelAnyValue(
  value: unknown,
  attributeKey: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeString(attributeKey, value);
  if (typeof value !== "object" || value === null) return value;
  if (depth > MAX_DEPTH || seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeOtelAnyValue(entry, attributeKey, depth + 1, seen))
      .filter((entry) => entry !== undefined);
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) continue;
    const sanitized = sanitizeOtelAnyValue(
      entry,
      attributeKey,
      depth + 1,
      seen,
    );
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function sanitizeUnknown(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string") return sanitizeString(key, value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeUnknown(entry, key, depth + 1, seen))
      .filter((entry) => entry !== undefined);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.key === "string" && "value" in record) {
    if (shouldDropKey(record.key)) return undefined;
    const result: Record<string, unknown> = { key: record.key };
    const sanitizedValue = sanitizeOtelAnyValue(
      record.value,
      record.key,
      depth + 1,
      seen,
    );
    if (sanitizedValue !== undefined) result.value = sanitizedValue;
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [childKey, entry] of Object.entries(record)) {
    if (
      childKey === "originalError" ||
      FORBIDDEN_PAYLOAD_KEY.test(childKey) ||
      shouldDropKey(childKey)
    ) {
      continue;
    }
    const sanitized = sanitizeUnknown(entry, childKey, depth + 1, seen);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

/**
 * Clone and sanitize a raw Faro transport item.
 *
 * This covers Faro's automatic errors, logs, web vitals, navigation events,
 * and OTLP trace payloads—not only signals created through the core client.
 */
export function sanitizeFaroTransportItem(item: TransportItem): TransportItem {
  const sanitized = sanitizeUnknown(item, "", 0, new WeakSet<object>()) as
    | TransportItem
    | undefined;
  if (!sanitized) throw new Error("Faro transport item could not be sanitized");

  // Faro's built-in browser meta includes the full current URL. Keep useful
  // origin/path data while removing credentials, query parameters, and hashes.
  if (sanitized.meta.user) {
    sanitized.meta.user = {
      ...(sanitized.meta.user.hash
        ? { hash: sanitizeString("user.hash", sanitized.meta.user.hash) }
        : {}),
      ...(sanitized.meta.user.roles
        ? { roles: sanitizeString("user.roles", sanitized.meta.user.roles) }
        : {}),
      ...(sanitized.meta.user.attributes
        ? { attributes: sanitized.meta.user.attributes }
        : {}),
    };
  }
  if (sanitized.meta.page?.url) {
    sanitized.meta.page.url = sanitizeUrl(sanitized.meta.page.url);
  }
  return sanitized;
}

/** Compose the mandatory privacy pass around an optional user Faro hook. */
export function createPrivacyBeforeSend(
  userHook?: BeforeSendHook,
): BeforeSendHook {
  return (item) => {
    try {
      const safeInput = sanitizeFaroTransportItem(item);
      const processed = userHook ? userHook(safeInput) : safeInput;
      return processed ? sanitizeFaroTransportItem(processed) : null;
    } catch {
      // A broken privacy/custom hook drops telemetry instead of breaking the app
      // or risking export of an unsanitized item.
      return null;
    }
  };
}
