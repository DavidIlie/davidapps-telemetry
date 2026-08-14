// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createTelemetryClient, type TelemetryAdapter } from "@davidapps/telemetry-core";
import { installAppStateTelemetry, type AppStateLike } from "./lifecycle.js";

describe("installAppStateTelemetry", () => {
  it("flushes when the application leaves the foreground", async () => {
    let listener: ((state: string) => void) | undefined;
    const remove = vi.fn();
    const appState: AppStateLike = {
      currentState: "active",
      addEventListener(_type, nextListener) {
        listener = nextListener;
        return { remove };
      },
    };
    const flush = vi.fn(async () => {});
    const adapter: TelemetryAdapter = { send() {}, flush };
    const client = createTelemetryClient({ adapter, resource: { serviceName: "fixture" } });

    const teardown = installAppStateTelemetry(client, appState);
    listener?.("background");
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    teardown();

    expect(remove).toHaveBeenCalledOnce();
  });
});
