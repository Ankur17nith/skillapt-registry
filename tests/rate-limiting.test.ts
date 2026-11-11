import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { resetRateLimits } from "../src/middleware/rate-limit";
import { computeSha256 } from "../src/utils/crypto";
import { RateLimiterDO, DurableObjectRateLimiter } from "../src/rate-limiter/do";
import type { Env } from "../src/types";

describe("Branch 7: Rate Limiting & Durable Object Architecture", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;
  const alexToken = "apt_live_testtoken1234567890abcdef";
  const rawSession = "ses_rate_limit_user";

  beforeEach(async () => {
    resetRateLimits();
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    await mockDb.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).bind(sessionHash, "usr_alexdev", expiresAt, new Date().toISOString()).run();

    await mockStorage.put("skills/pdf-summarizer/1.2.0.tgz", "MOCK_BYTES");

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test",
      GITHUB_CLIENT_ID: "mock_client_id",
      GITHUB_CLIENT_SECRET: "mock_client_secret"
    };
  });

  describe("1. SPEC Section 12 Limit Enforcement", () => {
    it("enforces search limit of 60 requests/min/IP (61st returns 429 + Retry-After)", async () => {
      const ip = "198.51.100.1";
      for (let i = 0; i < 60; i++) {
        const res = await app.request("/v1/skills?q=pdf", { headers: { "cf-connecting-ip": ip } }, env);
        expect(res.status).toBe(200);
      }

      const rateLimitedRes = await app.request("/v1/skills?q=pdf", { headers: { "cf-connecting-ip": ip } }, env);
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.headers.get("Retry-After")).toBeDefined();
      const body = (await rateLimitedRes.json()) as any;
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("enforces downloads limit of 120/min/IP (121st returns 429 + Retry-After)", async () => {
      const ip = "198.51.100.2";
      for (let i = 0; i < 120; i++) {
        const res = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", { headers: { "cf-connecting-ip": ip } }, env);
        expect(res.status).toBe(200);
      }

      const rateLimitedRes = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", { headers: { "cf-connecting-ip": ip } }, env);
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.headers.get("Retry-After")).toBeDefined();
      const body = (await rateLimitedRes.json()) as any;
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("enforces OAuth login flow limit of 20/10min/IP (21st returns 429 + Retry-After)", async () => {
      const ip = "198.51.100.3";
      for (let i = 0; i < 20; i++) {
        const res = await app.request("/v1/auth/github", { headers: { "cf-connecting-ip": ip } }, env);
        expect(res.status).toBe(302);
      }

      const rateLimitedRes = await app.request("/v1/auth/github", { headers: { "cf-connecting-ip": ip } }, env);
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.headers.get("Retry-After")).toBeDefined();
      const body = (await rateLimitedRes.json()) as any;
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("enforces token creation limit of 10/day/user (11th returns 429 + Retry-After)", async () => {
      for (let i = 0; i < 10; i++) {
        const res = await app.request(
          "/v1/tokens",
          {
            method: "POST",
            headers: {
              Cookie: `skillapt_session=${rawSession}`,
              Origin: "https://skillapt.dev",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ name: `token-${i}` })
          },
          env
        );
        expect(res.status).toBe(201);
      }

      const rateLimitedRes = await app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            Cookie: `skillapt_session=${rawSession}`,
            Origin: "https://skillapt.dev",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: "token-11" })
        },
        env
      );
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.headers.get("Retry-After")).toBeDefined();
      const body = (await rateLimitedRes.json()) as any;
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("enforces publish limit of 10/hour/user: 15 publishes -> the 11th is 429 + Retry-After", async () => {
      // 15 publishes:
      // Calls 1 to 10 reach the route (will fail with 400 bad payload, but rate limiter counts them)
      for (let i = 1; i <= 10; i++) {
        const res = await app.request(
          "/v1/skills",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${alexToken}`,
              "Content-Type": "application/gzip"
            },
            body: new Uint8Array([0, 1, 2])
          },
          env
        );
        // The first 10 pass rate limiting (and hit validation, returning 400)
        expect(res.status).toBe(400);
      }

      // The 11th through 15th must be rejected with 429 Too Many Requests
      for (let i = 11; i <= 15; i++) {
        const res = await app.request(
          "/v1/skills",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${alexToken}`,
              "Content-Type": "application/gzip"
            },
            body: new Uint8Array([0, 1, 2])
          },
          env
        );
        expect(res.status).toBe(429);
        expect(res.headers.get("Retry-After")).toBeDefined();
        const body = (await res.json()) as any;
        expect(body.error.code).toBe("RATE_LIMITED");
      }
    });

    it("uses ONLY cf-connecting-ip for client IP and ignores spoofed x-forwarded-for", async () => {
      const realIp = "203.0.113.88";
      const spoofedIp = "1.2.3.4";

      // Exhaust 5 reports using realIp
      for (let i = 0; i < 5; i++) {
        const res = await app.request(
          "/v1/reports",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "cf-connecting-ip": realIp,
              "x-forwarded-for": spoofedIp
            },
            body: JSON.stringify({
              skillName: "pdf-summarizer",
              version: "1.2.0",
              reason: "spam",
              details: "Spam report"
            })
          },
          env
        );
        expect(res.status).toBe(201);
      }

      // 6th request with different spoofed x-forwarded-for but same cf-connecting-ip is blocked!
      const blockedRes = await app.request(
        "/v1/reports",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": realIp,
            "x-forwarded-for": "9.9.9.9" // Attempted bypass via spoofing
          },
          body: JSON.stringify({
            skillName: "pdf-summarizer",
            version: "1.2.0",
            reason: "spam",
            details: "Spam report"
          })
        },
        env
      );
      expect(blockedRes.status).toBe(429);
    });
  });

  describe("2. DurableObjectRateLimiter Unit Tests", () => {
    it("correctly tracks sliding window and responds via mock DO", async () => {
      const kvStore = new Map<string, any>();
      const mockState: any = {
        storage: {
          get: async (k: string) => kvStore.get(k),
          put: async (k: string, v: any) => kvStore.set(k, v)
        }
      };

      const doInstance = new RateLimiterDO(mockState, env);

      // Check request 1
      const req1 = new Request("http://rate-limiter/limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-key", windowMs: 10000, maxRequests: 2 })
      });
      const res1 = await doInstance.fetch(req1);
      const data1 = (await res1.json()) as any;
      expect(data1.allowed).toBe(true);
      expect(data1.count).toBe(1);

      // Check request 2
      const req2 = new Request("http://rate-limiter/limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-key", windowMs: 10000, maxRequests: 2 })
      });
      const res2 = await doInstance.fetch(req2);
      const data2 = (await res2.json()) as any;
      expect(data2.allowed).toBe(true);
      expect(data2.count).toBe(2);

      // Check request 3 (breach)
      const req3 = new Request("http://rate-limiter/limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-key", windowMs: 10000, maxRequests: 2 })
      });
      const res3 = await doInstance.fetch(req3);
      const data3 = (await res3.json()) as any;
      expect(data3.allowed).toBe(false);
      expect(data3.count).toBe(3);
      expect(data3.retryAfterSeconds).toBeGreaterThan(0);
    });
  });
});
