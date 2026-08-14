// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createTelemetryClient, type TelemetryAdapter, type TelemetrySignal } from "@davidilie/telemetry-core";
import { createScreenTracker } from "./navigation.js";

describe("createScreenTracker", () => {
  it("captures changed screens without route params", async () => {
    const signals: TelemetrySignal[] = [];
    const adapter: TelemetryAdapter = {
      send(signal) {
        signals.push(signal);
      },
    };
    const client = createTelemetryClient({
      adapter,
      resource: { serviceName: "fixture" },
    });
    const tracker = createScreenTracker(client);

    tracker.track("Home");
    tracker.track("Home");
    tracker.track({ name: "Settings", key: "settings-private-key" });
    await client.flush();

    expect(signals).toHaveLength(2);
    expect(signals[0]?.attributes).toMatchObject({ "screen.name": "Home" });
    expect(signals[1]?.attributes).toMatchObject({
      "screen.name": "Settings",
      "screen.previous_name": "Home",
    });
    expect(JSON.stringify(signals)).not.toContain("settings-private-key");
  });
});
