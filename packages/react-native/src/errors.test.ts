// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryClient, type TelemetryAdapter, type TelemetrySignal } from "@davidilie/telemetry-core";
import { installGlobalErrorHandlers } from "./errors.js";

interface TestErrorGlobal {
  ErrorUtils?: {
    getGlobalHandler(): (error: Error, isFatal?: boolean) => void;
    setGlobalHandler(handler: (error: Error, isFatal?: boolean) => void): void;
  };
}

describe("installGlobalErrorHandlers", () => {
  const target = globalThis as unknown as TestErrorGlobal;
  const originalErrorUtils = target.ErrorUtils;

  afterEach(() => {
    target.ErrorUtils = originalErrorUtils;
  });

  it("captures fatal JS errors, delegates, and restores the previous handler", async () => {
    const signals: TelemetrySignal[] = [];
    const previous = vi.fn();
    let current = previous;
    target.ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler(handler) {
        current = handler;
      },
    };
    const adapter: TelemetryAdapter = {
      send(signal) {
        signals.push(signal);
      },
    };
    const client = createTelemetryClient({ adapter, resource: { serviceName: "fixture" } });

    const restore = installGlobalErrorHandlers(client, { captureUnhandledRejections: false });
    current(new Error("fixture exploded"), true);
    await client.flush();

    expect(previous).toHaveBeenCalledOnce();
    expect(signals[0]).toMatchObject({
      type: "exception",
      attributes: { "error.unhandled": true, "error.fatal": true },
    });
    restore();
    expect(current).toBe(previous);
  });
});
