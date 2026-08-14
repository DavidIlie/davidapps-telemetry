// SPDX-License-Identifier: Apache-2.0

import type { Attributes, TelemetryClient } from "@davidilie/telemetry-core";

interface ReactNativeErrorUtils {
  getGlobalHandler(): (error: Error, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: Error, isFatal?: boolean) => void): void;
}

interface ErrorHandlerGlobal {
  ErrorUtils?: ReactNativeErrorUtils;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
}

export interface GlobalErrorHandlerOptions {
  attributes?: Attributes;
  callPreviousHandler?: boolean;
  captureUnhandledRejections?: boolean;
}

function rejectionReason(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "reason" in event) {
    return (event as { reason: unknown }).reason;
  }
  return event;
}

export function installGlobalErrorHandlers(
  client: TelemetryClient,
  options: GlobalErrorHandlerOptions = {},
): () => void {
  const target = globalThis as unknown as ErrorHandlerGlobal;
  const errorUtils = target.ErrorUtils;
  const previous = errorUtils?.getGlobalHandler();
  const handler = (error: Error, isFatal = false) => {
    client.captureException(error, {
      ...options.attributes,
      "error.unhandled": true,
      "error.fatal": isFatal,
    });
    if ((options.callPreviousHandler ?? true) && previous) previous(error, isFatal);
  };

  errorUtils?.setGlobalHandler(handler);

  const rejectionHandler = (event: unknown) => {
    client.captureException(rejectionReason(event), {
      ...options.attributes,
      "error.unhandled": true,
      "error.promise_rejection": true,
    });
  };
  if (options.captureUnhandledRejections ?? true) {
    target.addEventListener?.("unhandledrejection", rejectionHandler);
  }

  return () => {
    if (errorUtils?.getGlobalHandler() === handler && previous) {
      errorUtils.setGlobalHandler(previous);
    }
    target.removeEventListener?.("unhandledrejection", rejectionHandler);
  };
}
