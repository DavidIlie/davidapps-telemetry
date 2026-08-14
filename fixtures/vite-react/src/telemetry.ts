import { initializeWebTelemetry } from "@davidilie/telemetry-web";

const ingestUrl = import.meta.env.VITE_TELEMETRY_INGEST_URL;
const enabled = import.meta.env.VITE_TELEMETRY_ENABLED === "true";
const commitSha = import.meta.env.VITE_COMMIT_SHA;

export const telemetry =
  enabled && ingestUrl
    ? initializeWebTelemetry({
        url: ingestUrl,
        resource: {
          serviceName: "telemetry-vite-fixture",
          // Production uses the exact deployed Git revision. `dev` is only a
          // local fixture fallback, never a marketing/application version.
          serviceVersion: commitSha ?? "dev",
          environment: import.meta.env.MODE,
          commitSha,
          repositoryUrl: "https://github.com/DavidIlie/davidapps-telemetry",
          platform: "web",
          attributes: { "davidapps.project.id": "telemetry-fixture" },
        },
        tracePropagationTargets: [location.origin],
      }).client
    : undefined;
