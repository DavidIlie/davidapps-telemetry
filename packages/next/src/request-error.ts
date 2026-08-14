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
    if (
      config.beforeCapture &&
      !(await config.beforeCapture(error, request, context))
    ) {
      return;
    }

    const digest = errorDigest(error);
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

    // Next.js requires asynchronous reporting started in onRequestError to be
    // awaited. This drains the core client; provider batching stays provider-owned.
    await config.telemetry.flush?.();
  };
}
