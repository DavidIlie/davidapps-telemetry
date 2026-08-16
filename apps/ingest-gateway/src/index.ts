import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { GatewayConfig, GatewayProject } from "./config.js";
import { validateGatewayConfig } from "./config.js";
import { GatewayMetrics } from "./metrics.js";
import { ProjectRateLimiter } from "./rate-limit.js";

type FetchImplementation = typeof globalThis.fetch;
type SignalRoute = "faro" | "traces" | "logs" | "metrics";

const ROUTES: Readonly<Record<string, SignalRoute>> = {
  "/collect": "faro",
  "/v1/traces": "traces",
  "/v1/logs": "logs",
  "/v1/metrics": "metrics",
};
const CORS_ALLOWED_HEADERS = [
  "content-type",
  "content-encoding",
  "traceparent",
  "tracestate",
  "baggage",
  "x-api-key",
  "x-faro-session-id",
] as const;
const CORS_ALLOWED_HEADERS_SET = new Set<string>(CORS_ALLOWED_HEADERS);
const CORS_EXPOSED_HEADERS = "retry-after, x-faro-session-status";

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

/**
 * Compare public routing keys without a length or prefix timing oracle. The
 * key is a public identifier rather than a credential, but the check should
 * still not teach an attacker how it differs byte by byte.
 */
function publicKeyMatches(presented: string | undefined, configured: string): boolean {
  if (presented === undefined) return false;
  const presentedDigest = createHash("sha256").update(presented).digest();
  const configuredDigest = createHash("sha256").update(configured).digest();
  return timingSafeEqual(presentedDigest, configuredDigest);
}

function hostname(request: FastifyRequest): string {
  return request.hostname.toLowerCase().replace(/\.$/, "");
}

function requestPath(request: FastifyRequest): string {
  return (request.raw.url ?? "").split("?", 1)[0] ?? "";
}

function routeForRequest(request: FastifyRequest): SignalRoute | undefined {
  return ROUTES[requestPath(request)];
}

function permits(project: GatewayProject, route: SignalRoute): boolean {
  if (route === "faro") return project.allowFaro ?? true;
  if (route === "traces") return project.allowTraces ?? true;
  if (route === "logs") return project.allowLogs ?? false;
  return project.allowMetrics ?? false;
}

function upstreamUrl(config: GatewayConfig, route: SignalRoute): URL {
  const base = route === "faro" ? config.faroUpstream : config.otlpUpstream;
  return new URL(route === "faro" ? "/collect" : `/v1/${route}`, base);
}

function requestPayload(body: unknown): Buffer {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (body === undefined || body === null) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(body));
}

function setCorsHeaders(reply: FastifyReply, origin: string): void {
  reply
    .header("access-control-allow-origin", origin)
    .header("access-control-expose-headers", CORS_EXPOSED_HEADERS)
    .header("vary", "Origin");
}

interface OutcomeFields {
  project: string;
  route: SignalRoute;
  outcome: string;
  statusCode: number;
  startedAt: number;
  requestBytes?: number;
  upstreamStatus?: number;
}

export interface GatewayRuntimeOptions {
  /** Keep production logging on by default; tests may use Fastify's silent logger. */
  logger?: FastifyServerOptions["logger"];
}

/**
 * Emit one bounded-cardinality result log per handled signal request. Never
 * include origins, URLs, public keys, trace/session IDs, headers, or bodies.
 */
function logOutcome(request: FastifyRequest, fields: OutcomeFields): void {
  request.log.info(
    {
      telemetry: {
        project: fields.project,
        route: fields.route,
        outcome: fields.outcome,
        status_code: fields.statusCode,
        duration_ms: Math.max(0, Math.round(performance.now() - fields.startedAt)),
        ...(fields.requestBytes === undefined ? {} : { request_bytes: fields.requestBytes }),
        ...(fields.upstreamStatus === undefined ? {} : { upstream_status: fields.upstreamStatus }),
      },
    },
    "telemetry gateway outcome",
  );
}

export function createGateway(
  inputConfig: GatewayConfig,
  fetchImplementation: FetchImplementation = globalThis.fetch,
  runtimeOptions: GatewayRuntimeOptions = {},
): FastifyInstance {
  const config = validateGatewayConfig(inputConfig);
  const app = Fastify({
    logger: runtimeOptions.logger ?? true,
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

  // Set CORS before body parsing so Fastify-generated errors such as 413 are
  // still readable by an allowed browser origin.
  app.addHook("onRequest", async (request, reply) => {
    const route = routeForRequest(request);
    if (!route) return;
    const project = projectsByHost.get(hostname(request));
    const origin = firstHeader(request.headers.origin);
    if (project && origin && project.allowedOrigins.includes(origin)) {
      setCorsHeaders(reply, origin);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const route = routeForRequest(request);
    const project = projectsByHost.get(hostname(request));
    const candidateStatus =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const statusCode =
      typeof candidateStatus === "number" && candidateStatus >= 400 ? candidateStatus : 500;
    const outcome = statusCode === 413 ? "body_too_large" : "request_error";
    if (route && project && permits(project, route)) {
      metrics.increment(project.id, route, outcome);
      logOutcome(request, {
        project: project.id,
        route,
        outcome,
        statusCode,
        startedAt: performance.now(),
      });
    }
    return reply.code(statusCode).send({ error: outcome });
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    if (projectsByHost.size === 0) return reply.code(503).send({ status: "unconfigured" });
    return { status: "ready" };
  });
  app.get("/metrics", async (_request, reply) => {
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
  });

  app.options("/*", async (request, reply) => {
    const startedAt = performance.now();
    const route = routeForRequest(request);
    const project = projectsByHost.get(hostname(request));
    if (!route || !project || !permits(project, route)) {
      if (route && project) {
        metrics.increment(project.id, route, "route_disabled");
        logOutcome(request, {
          project: project.id,
          route,
          outcome: "route_disabled",
          statusCode: 404,
          startedAt,
        });
      }
      return reply.code(404).send({ error: "not_found" });
    }

    const origin = firstHeader(request.headers.origin);
    if (!origin || !project.allowedOrigins.includes(origin)) {
      metrics.increment(project.id, route, "forbidden_origin");
      logOutcome(request, {
        project: project.id,
        route,
        outcome: "forbidden_origin",
        statusCode: 403,
        startedAt,
      });
      return reply.code(403).send({ error: "forbidden_origin" });
    }

    const requestedMethod = firstHeader(request.headers["access-control-request-method"]);
    if (requestedMethod && requestedMethod.toUpperCase() !== "POST") {
      metrics.increment(project.id, route, "forbidden_method");
      logOutcome(request, {
        project: project.id,
        route,
        outcome: "forbidden_method",
        statusCode: 405,
        startedAt,
      });
      return reply.header("allow", "POST, OPTIONS").code(405).send({ error: "method_not_allowed" });
    }

    const requestedHeaders = firstHeader(request.headers["access-control-request-headers"])
      ?.split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean) ?? [];
    if (requestedHeaders.some((header) => !CORS_ALLOWED_HEADERS_SET.has(header))) {
      metrics.increment(project.id, route, "forbidden_header");
      logOutcome(request, {
        project: project.id,
        route,
        outcome: "forbidden_header",
        statusCode: 403,
        startedAt,
      });
      return reply.code(403).send({ error: "forbidden_header" });
    }

    metrics.increment(project.id, route, "preflight");
    logOutcome(request, {
      project: project.id,
      route,
      outcome: "preflight",
      statusCode: 204,
      startedAt,
    });
    return reply
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", CORS_ALLOWED_HEADERS.join(", "))
      .header("access-control-max-age", "600")
      .code(204)
      .send();
  });

  for (const [path, route] of Object.entries(ROUTES)) {
    app.post(path, async (request, reply) => {
      const startedAt = performance.now();
      const project = projectsByHost.get(hostname(request));
      if (!project || !permits(project, route)) {
        if (project) {
          metrics.increment(project.id, route, "route_disabled");
          logOutcome(request, {
            project: project.id,
            route,
            outcome: "route_disabled",
            statusCode: 404,
            startedAt,
          });
        }
        return reply.code(404).send({ error: "not_found" });
      }

      const origin = firstHeader(request.headers.origin);
      if (origin && !project.allowedOrigins.includes(origin)) {
        metrics.increment(project.id, route, "forbidden_origin");
        logOutcome(request, {
          project: project.id,
          route,
          outcome: "forbidden_origin",
          statusCode: 403,
          startedAt,
        });
        return reply.code(403).send({ error: "forbidden_origin" });
      }

      if (project.publicKey && !publicKeyMatches(firstHeader(request.headers["x-api-key"]), project.publicKey)) {
        metrics.increment(project.id, route, "invalid_key");
        logOutcome(request, {
          project: project.id,
          route,
          outcome: "invalid_key",
          statusCode: 401,
          startedAt,
        });
        return reply.code(401).send({ error: "invalid_key" });
      }

      if (!limiter.take(project.id, project.ratePerSecond, project.burst)) {
        metrics.increment(project.id, route, "rate_limited");
        logOutcome(request, {
          project: project.id,
          route,
          outcome: "rate_limited",
          statusCode: 429,
          startedAt,
        });
        return reply.header("retry-after", "1").code(429).send({ error: "rate_limited" });
      }

      const body = requestPayload(request.body);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

      try {
        const headers: Record<string, string> = {
          "content-type": firstHeader(request.headers["content-type"]) ?? "application/json",
          "x-davidapps-project": project.id,
        };
        const contentEncoding = firstHeader(request.headers["content-encoding"]);
        const traceparent = firstHeader(request.headers.traceparent);
        const tracestate = firstHeader(request.headers.tracestate);
        const baggage = firstHeader(request.headers.baggage);
        const faroSessionId = firstHeader(request.headers["x-faro-session-id"]);
        if (contentEncoding) headers["content-encoding"] = contentEncoding;
        if (traceparent) headers.traceparent = traceparent;
        if (tracestate) headers.tracestate = tracestate;
        if (baggage) headers.baggage = baggage;
        if (route === "faro" && faroSessionId) headers["x-faro-session-id"] = faroSessionId;

        const response = await fetchImplementation(upstreamUrl(config, route), {
          method: "POST",
          body,
          headers,
          redirect: "error",
          signal: controller.signal,
        });
        const responseBody = Buffer.from(await response.arrayBuffer());
        // Preserve the original metric labels because deployed alerts consume
        // them. The structured outcome log and upstream_status retain detail.
        const metricResult = response.ok ? "accepted" : "upstream_error";
        const outcome = response.ok ? "accepted" : "upstream_rejected";

        metrics.increment(project.id, route, metricResult);
        logOutcome(request, {
          project: project.id,
          route,
          outcome,
          statusCode: response.status,
          upstreamStatus: response.status,
          requestBytes: body.byteLength,
          startedAt,
        });

        const contentType = response.headers.get("content-type");
        const retryAfter = response.headers.get("retry-after");
        const faroSessionStatus = route === "faro" ? response.headers.get("x-faro-session-status") : null;
        if (contentType) reply.header("content-type", contentType);
        if (retryAfter) reply.header("retry-after", retryAfter);
        if (faroSessionStatus) reply.header("x-faro-session-status", faroSessionStatus);
        return reply.code(response.status).send(responseBody);
      } catch {
        const timedOut = controller.signal.aborted;
        const outcome = timedOut ? "upstream_timeout" : "upstream_unavailable";
        const statusCode = timedOut ? 504 : 503;
        metrics.increment(project.id, route, "unavailable");
        logOutcome(request, {
          project: project.id,
          route,
          outcome,
          statusCode,
          requestBytes: body.byteLength,
          startedAt,
        });
        return reply.code(statusCode).send({ error: outcome });
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  return app;
}

export type { GatewayConfig, GatewayProject } from "./config.js";
export { configFromEnv, validateGatewayConfig } from "./config.js";
