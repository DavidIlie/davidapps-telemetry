import { describe, expect, it, vi } from "vitest";
import type { TransportItem } from "@grafana/faro-web-sdk";
import {
  createPrivacyBeforeSend,
  sanitizeFaroTransportItem,
} from "./privacy.js";

function item(value: unknown): TransportItem {
  return value as TransportItem;
}

describe("Faro privacy", () => {
  it("sanitizes automatic metadata, contexts, messages, and OTLP attributes", () => {
    const sanitized = sanitizeFaroTransportItem(
      item({
        type: "trace",
        payload: {
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: "http.url",
                    value: {
                      stringValue:
                        "https://alice:pass@example.com/orders?email=alice@example.com#private",
                    },
                  },
                  { key: "enduser.id", value: { stringValue: "user-123" } },
                  { key: "service.name", value: { stringValue: "storefront" } },
                ],
              },
            },
          ],
          message: "failed for alice@example.com token=secret-value",
          context: {
            authorization: "Bearer secret-value",
            token_count: "321",
          },
        },
        meta: {
          page: { url: "https://example.com/checkout?email=alice@example.com#card" },
          user: {
            id: "user-123",
            email: "alice@example.com",
            hash: "anonymous-hash",
            roles: "member",
            attributes: { email: "alice@example.com", plan: "pro" },
          },
        },
      }),
    ) as unknown as Record<string, any>;

    expect(sanitized.meta.page.url).toBe("https://example.com/checkout");
    expect(sanitized.meta.user).toEqual({
      hash: "anonymous-hash",
      roles: "member",
      attributes: { plan: "pro" },
    });
    expect(sanitized.payload.message).toContain("[REDACTED_EMAIL]");
    expect(sanitized.payload.message).toContain("token=[REDACTED]");
    expect(sanitized.payload.context).toEqual({ token_count: "321" });

    const attributes = sanitized.payload.resourceSpans[0].resource.attributes;
    expect(attributes).toHaveLength(2);
    expect(attributes[0].value.stringValue).toBe("https://example.com/orders");
    expect(attributes[1]).toEqual({
      key: "service.name",
      value: { stringValue: "storefront" },
    });
  });

  it("re-sanitizes user hook output and drops items when hooks fail", () => {
    const hook = createPrivacyBeforeSend((transportItem) => ({
      ...transportItem,
      payload: {
        ...transportItem.payload,
        context: { password: "reintroduced", plan: "pro" },
      },
    }) as TransportItem);
    const sanitized = hook(
      item({ type: "log", payload: { message: "ok" }, meta: {} }),
    ) as unknown as Record<string, any>;
    expect(sanitized.payload.context).toEqual({ plan: "pro" });

    const failure = vi.fn(() => {
      throw new Error("broken hook");
    });
    expect(
      createPrivacyBeforeSend(failure)(
        item({ type: "log", payload: { message: "ok" }, meta: {} }),
      ),
    ).toBeNull();
  });
});
