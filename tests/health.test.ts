import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { PRODUCT_NAME, REGISTRY_VERSION } from "../src/config";

describe("Health Check Endpoints", () => {
  it("GET /health returns 200 with product name and version", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; product: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.product).toBe(PRODUCT_NAME);
    expect(body.product).toBe("skillapt");
    expect(body.version).toBe(REGISTRY_VERSION);
  });

  it("GET /v1/health returns 200 with product name and version", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; product: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.product).toBe(PRODUCT_NAME);
    expect(body.product).toBe("skillapt");
    expect(body.version).toBe(REGISTRY_VERSION);
  });

  it("returns 404 for unknown endpoints in standard error format", async () => {
    const res = await app.request("/v1/nonexistent");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
