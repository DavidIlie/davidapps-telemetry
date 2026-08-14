import type { Attributes } from "@davidapps/telemetry-core";

export interface NextRequestErrorDetails {
  path: string;
  method: string;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export interface NextRequestErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
  revalidateReason?: string;
  renderType?: string;
}

export type NextRequestErrorHandler = (
  error: unknown,
  request: NextRequestErrorDetails,
  context: NextRequestErrorContext,
) => void | Promise<void>;

export interface NextRequestErrorReporter {
  captureException(error: unknown, attributes?: Attributes): void;
  flush?(): void | Promise<void>;
}

export interface NextRequestErrorHandlerConfig {
  telemetry: NextRequestErrorReporter;
  attributes?: Attributes;
  beforeCapture?: (
    error: unknown,
    request: NextRequestErrorDetails,
    context: NextRequestErrorContext,
  ) => boolean | Promise<boolean>;
  /** Optional fail-open diagnostics for hook, capture, or flush failures. */
  onError?: (
    error: unknown,
    stage: "beforeCapture" | "capture" | "flush",
  ) => void | Promise<void>;
}

async function reportFailure(
  config: NextRequestErrorHandlerConfig,
  error: unknown,
  stage: "beforeCapture" | "capture" | "flush",
): Promise<void> {
  try {
    await config.onError?.(error, stage);
  } catch {
    // Reporting telemetry diagnostics must never break a Next.js request.
  }
}

function errorDigest(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string"
  ) {
    return error.digest;
  }

  return undefined;
}

export function createNextRequestErrorHandler(
  config: NextRequestErrorHandlerConfig,
): NextRequestErrorHandler {
  return async (error, request, context) => {
    if (config.beforeCapture) {
      try {
        if (!(await config.beforeCapture(error, request, context))) return;
      } catch (hookError) {
        await reportFailure(config, hookError, "beforeCapture");
        return;
      }
    }

    const digest = errorDigest(error);
    try {
      config.telemetry.captureException(error, {
        ...config.attributes,
        "http.request.method": request.method,
        "url.path": request.path,
        "next.router.kind": context.routerKind,
        "next.route.path": context.routePath,
        "next.route.type": context.routeType,
        ...(context.renderSource
          ? { "next.render.source": context.renderSource }
          : {}),
        ...(context.revalidateReason
          ? { "next.revalidate.reason": context.revalidateReason }
          : {}),
        ...(context.renderType
          ? { "next.render.type": context.renderType }
          : {}),
        ...(digest ? { "next.error.digest": digest } : {}),
      });
    } catch (captureError) {
      await reportFailure(config, captureError, "capture");
      return;
    }

    // Next.js requires asynchronous reporting started in onRequestError to be
    // awaited. This drains the core client; provider batching stays provider-owned.
    try {
      await config.telemetry.flush?.();
    } catch (flushError) {
      await reportFailure(config, flushError, "flush");
    }
  };
}
