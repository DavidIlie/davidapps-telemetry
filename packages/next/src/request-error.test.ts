import { describe, expect, it, vi } from "vitest";
import { createNextRequestErrorHandler } from "./request-error.js";

describe("createNextRequestErrorHandler", () => {
  it("captures safe request metadata and waits for the reporter", async () => {
    const captureException = vi.fn();
    const flush = vi.fn(async () => undefined);
    const handler = createNextRequestErrorHandler({
      telemetry: { captureException, flush },
      attributes: { cluster: "davidapps-cluster" },
    });
    const error = Object.assign(new Error("render failed"), {
      digest: "digest-123",
    });

    await handler(
      error,
      {
        path: "/checkout",
        method: "POST",
        headers: { authorization: "Bearer never-capture-this" },
      },
      {
        routerKind: "App Router",
        routePath: "/checkout",
        routeType: "render",
        renderSource: "server-rendering",
      },
    );

    expect(captureException).toHaveBeenCalledWith(error, {
      cluster: "davidapps-cluster",
      "http.request.method": "POST",
      "url.path": "/checkout",
      "next.router.kind": "App Router",
      "next.route.path": "/checkout",
      "next.route.type": "render",
      "next.render.source": "server-rendering",
      "next.error.digest": "digest-123",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("can discard framework errors before capture", async () => {
    const captureException = vi.fn();
    const flush = vi.fn();
    const handler = createNextRequestErrorHandler({
      telemetry: { captureException, flush },
      beforeCapture: () => false,
    });

    await handler(
      new Error("ignored"),
      { path: "/", method: "GET" },
      { routerKind: "App Router", routePath: "/", routeType: "render" },
    );

    expect(captureException).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
});
