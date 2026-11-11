import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../../src/index";
import { MockD1Database } from "../helpers/mock-d1";
import { MockR2Bucket } from "../helpers/mock-r2";
import { computeSha256 } from "../../src/utils/crypto";
import type { Env } from "../../src/types";

describe("Branch 5 Security: Auth, Sessions, CSRF, and CORS", () => {
  let mockDb: MockD1Database;
  let env: Env;
  const validToken = "apt_live_testtoken1234567890abcdef";
  const rawSession = "ses_valid_cookie_12345";

  beforeEach(async () => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();

    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    await mockDb.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).bind(sessionHash, "usr_alexdev", expiresAt, new Date().toISOString()).run();

    env = {
      DB: mockDb.asD1(),
      STORAGE: new MockR2Bucket().asR2(),
      ENVIRONMENT: "test",
      CORS_ORIGIN: "https://skillapt.dev,http://localhost:3000"
    };
  });

  describe("1. CSRF Protection", () => {
    it("rejects state-changing POST/DELETE with cookie session when Origin is hostile (403 CSRF_VIOLATION)", async () => {
      const res = await app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            Cookie: `skillapt_session=${rawSession}`,
            Origin: "https://evil-attacker.com",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: "evil-token" })
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("CSRF_VIOLATION");
    });

    it("accepts state-changing request with cookie session when Origin matches allowed list", async () => {
      const res = await app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            Cookie: `skillapt_session=${rawSession}`,
            Origin: "https://skillapt.dev",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: "valid-token" })
        },
        env
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.name).toBe("valid-token");
    });

    it("exempts Bearer token requests from CSRF origin checks", async () => {
      const res = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${validToken}`,
            Origin: "https://random-cli-origin.net",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Yanked from CLI" })
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.yanked).toBe(true);
    });
  });

  describe("2. CORS Allowlist & Wildcard Rejection", () => {
    it("rejects wildcard '*' in CORS_ORIGIN with a configuration error", async () => {
      const wildcardEnv: Env = {
        ...env,
        CORS_ORIGIN: "*"
      };

      const res = await app.request(
        "/v1/health",
        {
          headers: { Origin: "https://skillapt.dev" }
        },
        wildcardEnv
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("CONFIG_ERROR");
      expect(body.error.message).toContain("wildcard");
    });

    it("disallows localhost origins when ENVIRONMENT=production", async () => {
      const prodEnv: Env = {
        ...env,
        ENVIRONMENT: "production",
        CORS_ORIGIN: "https://skillapt.dev,http://localhost:3000"
      };

      const res = await app.request(
        "/v1/health",
        {
          headers: { Origin: "http://localhost:3000" }
        },
        prodEnv
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Vary")).toContain("Origin");
    });

    it("includes Vary: Origin and security headers on responses", async () => {
      const res = await app.request("/v1/health", {}, env);
      expect(res.headers.get("Vary")).toContain("Origin");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });
  });

  describe("3. API Token Constraints & Expiration", () => {
    it("rejects token minting when using an API token (requires session)", async () => {
      const res = await app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${validToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: "nested-token" })
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("enforces maximum 20 active tokens per user", async () => {
      // Seed 20 tokens for usr_alexdev
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 864000000).toISOString();
      for (let i = 0; i < 20; i++) {
        await mockDb.prepare(
          "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(`tok_limit_${i}`, "usr_alexdev", `tok-${i}`, "apt_", `hash_${i}`, future, now).run();
      }

      // 21st token should be rejected with LIMIT_EXCEEDED
      const res = await app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            Cookie: `skillapt_session=${rawSession}`,
            Origin: "https://skillapt.dev",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: "token-21" })
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("LIMIT_EXCEEDED");
    });

    it("enforces token expiration in authenticate()", async () => {
      const expiredToken = "apt_live_expiredtoken1234567890abcdef";
      const tokenHash = await computeSha256(new TextEncoder().encode(expiredToken));
      const past = new Date(Date.now() - 3600000).toISOString();

      await mockDb.prepare(
        "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("tok_expired_test", "usr_alexdev", "expired-token", "apt_live_expi", tokenHash, past, past).run();

      const res = await app.request(
        "/v1/me",
        {
          headers: { Authorization: `Bearer ${expiredToken}` }
        },
        env
      );

      expect(res.status).toBe(401);
    });
  });

  describe("4. Error Handling and Information Leakage", () => {
    it("does not leak server error message in production and returns requestId", async () => {
      const prodEnv: Env = {
        ...env,
        ENVIRONMENT: "production",
        DB: {
          ...mockDb.asD1(),
          prepare() {
            throw new Error("Sensitive database stack trace or internal connection detail");
          }
        } as any
      };

      const res = await app.request("/v1/skills/pdf-summarizer", {}, prodEnv);
      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(body.error.message).toBe("An unexpected server error occurred.");
      expect(body.error.requestId).toBeDefined();
      expect(JSON.stringify(body)).not.toContain("Sensitive database stack trace");
    });
  });
});
