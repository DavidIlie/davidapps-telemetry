import { configFromEnv } from "./config.js";
import { createGateway } from "./index.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const gateway = createGateway(configFromEnv());

await gateway.listen({ host, port });

