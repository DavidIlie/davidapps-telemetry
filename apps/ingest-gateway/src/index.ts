import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import type { GatewayConfig, GatewayProject } from "./config.js";
import { GatewayMetrics } from "./metrics.js";
import { ProjectRateLimiter } from "./rate-limit.js";

type FetchImplementation = typeof globalThis.fetch;
type SignalRoute = "faro" | "traces" | "logs" | "metrics";

const ROUTES: Record<string, SignalRoute> = {
  "/collect": "faro",
  "/v1/traces": "traces",
  "/v1/logs": "logs",
  "/v1/metrics": "metrics",
};

function hostname(request: FastifyRequest): string {
  return request.hostname.toLowerCase().replace(/\.$/, "");
}

function permits(project: GatewayProject, route: SignalRoute): boolean {
  if (route === "faro") return project.allowFaro ?? true;
  if (route === "traces") return project.allowTraces ?? true;
  if (route === "logs") return project.allowLogs ?? false;
  return project.allowMetrics ?? false;
}

function upstreamUrl(config: GatewayConfig, route: SignalRoute): URL {
  const base = route === "faro" ? config.faroUpstream : config.otlpUpstream;
  const path = route === "faro" ? "/collect" : `/v1/${route}`;
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

function payload(body: unknown): string | Buffer {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

export function createGateway(
  config: GatewayConfig,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): FastifyInstance {
  const app = Fastify({
    logger: true,
    bodyLimit: config.maxBodyBytes,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const limiter = new ProjectRateLimiter();
  const metrics = new GatewayMetrics();
  const projectsByHost = new Map(
    config.projects.flatMap((project) =>
      project.hosts.map((host) => [host.toLowerCase(), project] as const),
    ),
  );

  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    if (projectsByHost.size === 0) return reply.code(503).send({ status: "unconfigured" });
    return { status: "ready" };
  });
  app.get("/metrics", async (_request, reply) => {
    return reply.type("text/plain; version=0.0.4").send(metrics.render());
  });

  app.options("/*", async (request, reply) => {
    const project = projectsByHost.get(hostname(request));
    const origin = request.headers.origin;
    if (!project || !origin || !project.allowedOrigins.includes(origin)) return reply.code(403).send();
    return reply
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", "content-type, content-encoding, traceparent, x-api-key")
      .header("vary", "Origin")
      .code(204)
      .send();
  });

  for (const [path, route] of Object.entries(ROUTES)) {
    app.post(path, async (request, reply) => {
      const project = projectsByHost.get(hostname(request));
      if (!project || !permits(project, route)) return reply.code(404).send({ error: "not_found" });

      const origin = request.headers.origin;
      if (origin && !project.allowedOrigins.includes(origin)) {
        metrics.increment(project.id, route, "forbidden_origin");
        return reply.code(403).send({ error: "forbidden_origin" });
      }

      if (project.publicKey && request.headers["x-api-key"] !== project.publicKey) {
        metrics.increment(project.id, route, "invalid_key");
        return reply.code(401).send({ error: "invalid_key" });
      }

      if (!limiter.take(project.id, project.ratePerSecond, project.burst)) {
        metrics.increment(project.id, route, "rate_limited");
        return reply.code(429).send({ error: "rate_limited" });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

      try {
        const traceparent = request.headers.traceparent;
        const headers: Record<string, string> = {
          "content-type": request.headers["content-type"] ?? "application/json",
          "x-davidapps-project": project.id,
        };
        if (request.headers["content-encoding"]) {
          headers["content-encoding"] = request.headers["content-encoding"];
        }
        if (traceparent) headers.traceparent = Array.isArray(traceparent) ? traceparent[0] ?? "" : traceparent;

        const response = await fetchImplementation(upstreamUrl(config, route), {
          method: "POST",
          body: payload(request.body),
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          metrics.increment(project.id, route, "upstream_error");
          return reply.code(502).send({ error: "upstream_rejected" });
        }

        metrics.increment(project.id, route, "accepted");
        if (origin) {
          reply.header("access-control-allow-origin", origin).header("vary", "Origin");
        }
        return reply.code(202).send();
      } catch {
        metrics.increment(project.id, route, "unavailable");
        return reply.code(503).send({ error: "upstream_unavailable" });
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  return app;
}

export type { GatewayConfig, GatewayProject } from "./config.js";
export { configFromEnv } from "./config.js";
