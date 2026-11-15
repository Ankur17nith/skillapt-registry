import { describe, it, expect } from "vitest";
import { app } from "../../src/index";
import { MockD1Database } from "../helpers/mock-d1";
import { MockR2Bucket } from "../helpers/mock-r2";
import { InMemoryRateLimiter } from "../../src/rate-limiter/do";
import type { Env } from "../../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  const db = new MockD1Database();
  db.applyMigrations();
  db.applySeed();
  return {
    DB: db.asD1(),
    STORAGE: new MockR2Bucket().asR2(),
    RATE_LIMITER: new InMemoryRateLimiter(),
    ...overrides
  };
}

describe("Security: safe-by-default environment handling", () => {
  it("does not allow any browser origin in production when CORS_ORIGIN is unset", async () => {
    const env = makeEnv({ ENVIRONMENT: "production" });
    for (const origin of ["https://skillapt.dev", "http://localhost:3000", "https://evil.example"]) {
      const res = await app.request("/v1/health", { headers: { Origin: origin } }, env);
      expect(res.headers.get("Access-Control-Allow-Origin"), origin).toBeNull();
    }
  });

  it("treats a missing ENVIRONMENT as production (no localhost origins, masked errors)", async () => {
    const env = makeEnv();
    const cors = await app.request("/v1/health", { headers: { Origin: "http://localhost:3000" } }, env);
    expect(cors.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("SQLITE_ERROR: secret internal detail");
        }
      }
    } as unknown as Env;
    const res = await app.request("/v1/stats", {}, broken);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret internal detail");
  });

  it("still exposes internal error details when ENVIRONMENT=development", async () => {
    const broken = {
      ...makeEnv({ ENVIRONMENT: "development" }),
      DB: {
        prepare: () => {
          throw new Error("dev-only detail");
        }
      }
    } as unknown as Env;
    const res = await app.request("/v1/stats", {}, broken);
    expect(await res.text()).toContain("dev-only detail");
  });

  it("honors PUBLIC_ORIGIN and CORS_ORIGIN entries in production", async () => {
    const env = makeEnv({
      ENVIRONMENT: "production",
      PUBLIC_ORIGIN: "https://registry.example.workers.dev",
      CORS_ORIGIN: "https://web.example.pages.dev,http://localhost:3000"
    });
    const web = await app.request("/v1/health", { headers: { Origin: "https://web.example.pages.dev" } }, env);
    expect(web.headers.get("Access-Control-Allow-Origin")).toBe("https://web.example.pages.dev");
    const self = await app.request("/v1/health", { headers: { Origin: "https://registry.example.workers.dev" } }, env);
    expect(self.headers.get("Access-Control-Allow-Origin")).toBe("https://registry.example.workers.dev");
    const local = await app.request("/v1/health", { headers: { Origin: "http://localhost:3000" } }, env);
    expect(local.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("sends HSTS and a locked-down CSP on API responses in production", async () => {
    const res = await app.request("/v1/health", {}, makeEnv({ ENVIRONMENT: "production" }));
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("does not send HSTS in development (plain http on localhost)", async () => {
    const res = await app.request("/v1/health", {}, makeEnv({ ENVIRONMENT: "development" }));
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("rejects oversized JSON bodies on non-upload endpoints with 413", async () => {
    const env = makeEnv({ ENVIRONMENT: "test" });
    const res = await app.request(
      "/v1/reports",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024) },
        body: JSON.stringify({ details: "x".repeat(2 * 1024 * 1024) })
      },
      env
    );
    expect(res.status).toBe(413);
  });
});
