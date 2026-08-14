import { configFromEnv } from "./config.js";
import { createGateway } from "./index.js";

function listenPort(value: string | undefined): number {
  const port = value === undefined ? 8080 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const port = listenPort(process.env.PORT);
const host = process.env.HOST ?? "0.0.0.0";
const gateway = createGateway(configFromEnv());
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  gateway.log.info({ signal }, "telemetry gateway shutting down");

  try {
    // Fastify stops accepting connections and waits for active requests. This
    // keeps the gateway stateless while allowing in-flight batches to finish.
    await gateway.close();
  } catch {
    process.exitCode = 1;
    gateway.log.error({ signal }, "telemetry gateway shutdown failed");
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

await gateway.listen({ host, port });
