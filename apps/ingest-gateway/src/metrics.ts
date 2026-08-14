type Route = "faro" | "traces" | "logs" | "metrics";

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

    for (const [key, count] of this.#requests) {
      const [project, route, result] = key.split("\u0000");
      lines.push(
        `telemetry_gateway_requests_total{project="${project}",route="${route}",result="${result}"} ${count}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }
}

