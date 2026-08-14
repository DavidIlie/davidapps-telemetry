import { initializeWebTelemetry } from "@davidilie/telemetry-web";

const enabled = process.env.NEXT_PUBLIC_TELEMETRY_ENABLED === "true";
const url = process.env.NEXT_PUBLIC_TELEMETRY_INGEST_URL;

// Client instrumentation is intentionally separate from instrumentation.ts.
// The fixture remains offline unless both public variables explicitly opt in.
if (enabled && url) {
  initializeWebTelemetry({
    url,
    enabled: true,
    resource: {
      serviceName: "telemetry-next-16-fixture-browser",
      ...(process.env.NEXT_PUBLIC_APP_VERSION
        ? { serviceVersion: process.env.NEXT_PUBLIC_APP_VERSION }
        : {}),
      ...(process.env.NODE_ENV
        ? { environment: process.env.NODE_ENV }
        : {}),
      ...(process.env.NEXT_PUBLIC_COMMIT_SHA
        ? { commitSha: process.env.NEXT_PUBLIC_COMMIT_SHA }
        : {}),
      namespace: "davidapps-telemetry",
      repositoryUrl: "https://github.com/davidilie/davidapps-telemetry",
      platform: "web",
    },
    tracePropagationTargets: [location.origin],
  });
}
