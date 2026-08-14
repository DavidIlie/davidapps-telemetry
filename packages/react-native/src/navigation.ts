// SPDX-License-Identifier: Apache-2.0

import type { Attributes, TelemetryClient } from "@davidapps/telemetry-core";

export interface RouteLike {
  name: string;
  key?: string;
}

export interface NavigationRefLike {
  getCurrentRoute(): RouteLike | undefined;
}

export interface ScreenTracker {
  track(route: string | RouteLike | undefined, attributes?: Attributes): void;
  onReady(ref: NavigationRefLike): void;
  onStateChange(ref: NavigationRefLike): void;
  current(): string | undefined;
  reset(): void;
}

function routeName(route: string | RouteLike | undefined): string | undefined {
  if (typeof route === "string") return route || undefined;
  return route?.name || undefined;
}

export function createScreenTracker(
  client: TelemetryClient,
  commonAttributes: Attributes = {},
): ScreenTracker {
  let currentScreen: string | undefined;

  const track = (route: string | RouteLike | undefined, attributes: Attributes = {}) => {
    const nextScreen = routeName(route);
    if (!nextScreen || nextScreen === currentScreen) return;
    const previousScreen = currentScreen;
    currentScreen = nextScreen;
    client.capture("screen_view", {
      ...commonAttributes,
      ...attributes,
      "screen.name": nextScreen,
      ...(previousScreen ? { "screen.previous_name": previousScreen } : {}),
    });
  };

  return {
    track,
    onReady(ref) {
      track(ref.getCurrentRoute());
    },
    onStateChange(ref) {
      track(ref.getCurrentRoute());
    },
    current() {
      return currentScreen;
    },
    reset() {
      currentScreen = undefined;
    },
  };
}
