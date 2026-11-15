import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { InMemoryRateLimiter } from "../src/rate-limiter/do";
import type { Env } from "../src/types";

function makeEnv(extra: Partial<Env> = {}): Env {
  const db = new MockD1Database();
  db.applyMigrations();
  db.applySeed();
  return {
    DB: db.asD1(),
    STORAGE: new MockR2Bucket().asR2(),
    ENVIRONMENT: "test",
    RATE_LIMITER: new InMemoryRateLimiter(),
    ...extra
  };
}

describe("Read-only maintenance mode (MAINTENANCE_MODE=true)", () => {
  const token = "apt_live_testtoken1234567890abcdef";

  it("rejects mutating requests with 503 and a Retry-After header", async () => {
    const env = makeEnv({ MAINTENANCE_MODE: "true" });
    for (const [method, path] of [
      ["POST", "/v1/skills"],
      ["POST", "/v1/tokens"],
      ["POST", "/v1/reports"],
      ["POST", "/v1/skills/pdf-summarizer/1.2.0/yank"],
      ["DELETE", "/v1/skills/pdf-summarizer/1.2.0/yank"],
      ["POST", "/dashboard/tokens"]
    ] as const) {
      const res = await app.request(
        path,
        { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined },
        env
      );
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("MAINTENANCE");
    }
  });

  it("keeps reads and logout available", async () => {
    const env = makeEnv({ MAINTENANCE_MODE: "true" });
    expect((await app.request("/v1/skills", {}, env)).status).toBe(200);
    expect((await app.request("/v1/health", {}, env)).status).toBe(200);
    const logout = await app.request("/v1/auth/logout", { method: "POST" }, env);
    expect(logout.status).toBe(200);
  });

  it("does nothing when MAINTENANCE_MODE is unset or not 'true'", async () => {
    for (const value of [undefined, "false", ""]) {
      const env = makeEnv({ MAINTENANCE_MODE: value });
      const res = await app.request(
        "/v1/reports",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        env
      );
      expect(res.status).toBe(400); // normal validation error, not 503
    }
  });
});
