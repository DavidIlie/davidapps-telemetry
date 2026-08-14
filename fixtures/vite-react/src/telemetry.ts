import { initializeWebTelemetry } from "@davidapps/telemetry-web";

const ingestUrl = import.meta.env.VITE_TELEMETRY_INGEST_URL;
const enabled = import.meta.env.VITE_TELEMETRY_ENABLED === "true";

export const telemetry =
  enabled && ingestUrl
    ? initializeWebTelemetry({
        url: ingestUrl,
        resource: {
          serviceName: "telemetry-vite-fixture",
          serviceVersion: import.meta.env.VITE_APP_VERSION ?? "dev",
          environment: import.meta.env.MODE,
          commitSha: import.meta.env.VITE_COMMIT_SHA,
          repositoryUrl: "https://github.com/david/davidapps-telemetry",
          platform: "web",
        },
        tracePropagationTargets: [location.origin],
      }).client
    : undefined;
