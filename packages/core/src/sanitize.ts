import type { Attributes, AttributeValue, TelemetrySignal } from "./types.js";

const FORBIDDEN_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|request[_-]?body|response[_-]?body|e-?mail|phone)/i;
const URL_KEY = /(?:^|[._-])(?:url|uri|href)$/i;
const MAX_ATTRIBUTE_COUNT = 64;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 2_048;
const MAX_STACK_LENGTH = 16_384;

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "";
  }
}

function sanitizeString(value: string): string {
  return value.slice(0, MAX_VALUE_LENGTH);
}

function sanitizeValue(key: string, value: AttributeValue): AttributeValue {
  if (typeof value === "string") {
    return sanitizeString(URL_KEY.test(key) ? scrubUrl(value) : value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) =>
      typeof entry === "string" ? sanitizeString(entry) : entry,
    );
  }

  return value;
}

export function sanitizeAttributes(attributes: Attributes = {}): Record<string, AttributeValue> {
  const sanitized: Record<string, AttributeValue> = {};

  for (const [key, value] of Object.entries(attributes).slice(0, MAX_ATTRIBUTE_COUNT)) {
    if (
      value == null ||
      key.length > MAX_KEY_LENGTH ||
      FORBIDDEN_KEY.test(key)
    ) {
      continue;
    }

    sanitized[key] = sanitizeValue(key, value);
  }

  return sanitized;
}

export function sanitizeSignal(signal: TelemetrySignal): TelemetrySignal {
  const common = {
    ...signal,
    attributes: sanitizeAttributes(signal.attributes),
  };

  switch (signal.type) {
    case "exception":
      return {
        ...common,
        type: "exception",
        exception: {
          name: sanitizeString(signal.exception.name),
          message: sanitizeString(signal.exception.message),
          ...(signal.exception.stack
            ? { stack: signal.exception.stack.slice(0, MAX_STACK_LENGTH) }
            : {}),
          ...(signal.exception.cause
            ? { cause: sanitizeString(signal.exception.cause) }
            : {}),
        },
      };
    case "log":
      return { ...common, type: "log", level: signal.level, message: sanitizeString(signal.message) };
    case "event":
      return { ...common, type: "event", name: sanitizeString(signal.name) };
    case "measurement":
      return {
        ...common,
        type: "measurement",
        name: sanitizeString(signal.name),
        value: signal.value,
        ...(signal.unit ? { unit: sanitizeString(signal.unit) } : {}),
      };
  }
}
