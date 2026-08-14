export interface GatewayProject {
  id: string;
  hosts: readonly string[];
  allowedOrigins: readonly string[];
  publicKey?: string;
  ratePerSecond?: number;
  burst?: number;
  allowFaro?: boolean;
  allowTraces?: boolean;
  allowLogs?: boolean;
  allowMetrics?: boolean;
}

export interface GatewayConfig {
  projects: readonly GatewayProject[];
  faroUpstream: string;
  otlpUpstream: string;
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
}

function parseProjects(value: string | undefined): GatewayProject[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("TELEMETRY_PROJECTS_JSON must be an array");

  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid telemetry project");
    const project = item as Partial<GatewayProject>;
    if (!project.id || !Array.isArray(project.hosts) || !Array.isArray(project.allowedOrigins)) {
      throw new Error("Telemetry projects require id, hosts, and allowedOrigins");
    }
    return project as GatewayProject;
  });
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    projects: parseProjects(env.TELEMETRY_PROJECTS_JSON),
    faroUpstream: env.ALLOY_FARO_URL ?? "http://alloy.observability.svc.cluster.local:12347",
    otlpUpstream: env.ALLOY_OTLP_URL ?? "http://alloy.observability.svc.cluster.local:4318",
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 524_288),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 5_000),
  };
}

