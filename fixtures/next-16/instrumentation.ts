import {
  createNextRequestErrorHandler,
  type NextRequestErrorHandler,
} from "@davidilie/telemetry-next";
import type { Instrumentation } from "next";

let reportRequestError: NextRequestErrorHandler | undefined;

export async function register(): Promise<void> {
  // The explicit guard makes production opt-in and keeps fixture builds fully
  // offline. It also prevents Node-only code from entering the Edge graph.
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.TELEMETRY_ENABLED !== "true"
  ) {
    return;
  }

  const { registerNextTelemetry } = await import(
    "@davidilie/telemetry-next/node"
  );
  const telemetry = registerNextTelemetry({
    resource: {
      serviceName: "telemetry-next-16-fixture",
      ...(process.env.GIT_SHA
        ? {
            serviceVersion: process.env.GIT_SHA,
            commitSha: process.env.GIT_SHA,
          }
        : {}),
      ...(process.env.NODE_ENV
        ? { environment: process.env.NODE_ENV }
        : {}),
      namespace: "davidapps-telemetry",
      repositoryUrl: "https://github.com/davidilie/davidapps-telemetry",
      platform: "node",
    },
  });

  reportRequestError = createNextRequestErrorHandler({ telemetry });
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  await reportRequestError?.(error, request, context);
};
