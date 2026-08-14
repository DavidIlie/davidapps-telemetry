type Route = "faro" | "traces" | "logs" | "metrics";

// Prometheus text labels escape exactly these three characters. This remains
// necessary even though project IDs are validated: keeping the formatter safe
// prevents future callers from turning labels into injected metric samples.
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class GatewayMetrics {
  readonly #requests = new Map<string, number>();

  increment(project: string, route: Route, result: string): void {
    const key = `${project}\u0000${route}\u0000${result}`;
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      "# HELP telemetry_gateway_requests_total Requests handled by project, route, and result.",
      "# TYPE telemetry_gateway_requests_total counter",
    ];

    for (const [key, count] of [...this.#requests].sort(([left], [right]) => left.localeCompare(right))) {
      const [project, route, result] = key.split("\u0000");
      lines.push(
        `telemetry_gateway_requests_total{project="${escapeLabel(project ?? "")}",route="${escapeLabel(route ?? "")}",result="${escapeLabel(result ?? "")}"} ${count}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }
}
