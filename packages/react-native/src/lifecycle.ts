// SPDX-License-Identifier: Apache-2.0

import type { Attributes, TelemetryClient } from "@davidilie/telemetry-core";

export interface AppStateSubscription {
  remove(): void;
}

export interface AppStateLike {
  currentState: string | null;
  addEventListener(
    type: "change",
    listener: (state: string) => void,
  ): AppStateSubscription | (() => void) | undefined;
}

export interface AppStateTelemetryOptions {
  attributes?: Attributes;
  captureTransitions?: boolean;
  flushOnBackground?: boolean;
}

export function installAppStateTelemetry(
  client: TelemetryClient,
  appState: AppStateLike,
  options: AppStateTelemetryOptions = {},
): () => void {
  let previousState = appState.currentState ?? "unknown";
  const listener = (nextState: string) => {
    if (nextState === previousState) return;
    if (options.captureTransitions ?? true) {
      client.capture("app.state_changed", {
        ...options.attributes,
        "app.state.previous": previousState,
        "app.state.current": nextState,
      });
    }
    previousState = nextState;
    if ((options.flushOnBackground ?? true) && nextState !== "active") {
      void client.flush();
    }
  };
  const subscription = appState.addEventListener("change", listener);

  return () => {
    if (typeof subscription === "function") subscription();
    else subscription?.remove();
  };
}

export interface StartupTracker {
  markInteractive(attributes?: Attributes): void;
  cancel(): void;
}

export function createStartupTracker(
  client: TelemetryClient,
  startedAt = Date.now(),
  attributes: Attributes = {},
): StartupTracker {
  const span = client.startSpan("app.startup", attributes);
  let ended = false;

  return {
    markInteractive(extraAttributes = {}) {
      if (ended) return;
      ended = true;
      const duration = Math.max(0, Date.now() - startedAt);
      span.setAttribute("app.startup.duration_ms", duration);
      for (const [key, value] of Object.entries(extraAttributes)) {
        if (value != null) span.setAttribute(key, value);
      }
      span.end();
      client.measure("app.time_to_interactive", duration, attributes, "ms");
    },
    cancel() {
      if (ended) return;
      ended = true;
      span.setAttribute("app.startup.cancelled", true);
      span.end();
    },
  };
}
