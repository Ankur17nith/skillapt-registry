import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import type { Env } from "../src/types";

describe("Authentication, Sessions, and API Tokens", () => {
  let mockDb: MockD1Database;
  let env: Env;

  // Pre-seeded token in migrations/seed.sql:
  // raw token: 'apt_live_testtoken1234567890abcdef' belongs to 'usr_alexdev'
  const validToken = "apt_live_testtoken1234567890abcdef";

  beforeEach(() => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    env = {
      DB: mockDb.asD1(),
      STORAGE: new MockR2Bucket().asR2(),
      ENVIRONMENT: "test",
      GITHUB_CLIENT_ID: "mock_client_id",
      GITHUB_CLIENT_SECRET: "mock_client_secret"
    };
  });

  describe("GET /v1/me", () => {
    it("returns 401 Unauthorized when no token or session is provided", async () => {
      const res = await app.request("/v1/me", {}, env);
      expect(res.status).toBe(401);

      const body = await res.json() as any;
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns authenticated user details using valid Bearer token", async () => {
      const res = await app.request(
        "/v1/me",
        {
          headers: {
            Authorization: `Bearer ${validToken}`
          }
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe("usr_alexdev");
      expect(body.handle).toBe("alexdev");
      expect(body.email).toBe("alex@example.com");
    });

    it("returns authenticated user details using valid session cookie", async () => {
      // Insert a test session for usr_sarahai
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      await mockDb.prepare(
        "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
      ).bind("ses_test_sarah", "usr_sarahai", expiresAt, new Date().toISOString()).run();

      const res = await app.request(
        "/v1/me",
        {
          headers: {
            Cookie: "skillapt_session=ses_test_sarah"
          }
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.handle).toBe("sarahai");
    });

    it("rejects expired session cookies", async () => {
      const expiredTime = new Date(Date.now() - 86400000).toISOString();
      await mockDb.prepare(
        "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
      ).bind("ses_expired", "usr_sarahai", expiredTime, new Date().toISOString()).run();

      const res = await app.request(
        "/v1/me",
        {
          headers: {
            Cookie: "skillapt_session=ses_expired"
          }
        },
        env
      );

      expect(res.status).toBe(401);
    });
  });

  describe("Token Management (/v1/tokens)", () => {
    it("lists active API tokens for authenticated user", async () => {
      const res = await app.request(
        "/v1/tokens",
        {
          headers: { Authorization: `Bearer ${validToken}` }
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.tokens).toBeDefined();
      expect(body.tokens.length).toBeGreaterThanOrEqual(1);
      expect(body.tokens[0].name).toBe("cli-macbook");
      expect(body.tokens[0].prefix).toBe("apt_live_test");
    });

    it("creates a new API token, hashes it with SHA-256, and returns token once", async () => {
      const createRes = await app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${validToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: "cli-ubuntu" })
        },
        env
      );

      expect(createRes.status).toBe(201);
      const createBody = await createRes.json() as any;
      expect(createBody.name).toBe("cli-ubuntu");
      expect(createBody.token).toMatch(/^apt_live_[a-f0-9]{32}$/);
      expect(createBody.warning).toContain("Copy this token now");

      const newToken = createBody.token;

      // Ensure the raw token is NOT stored in plain text in D1
      const rawInDb = await mockDb.prepare("SELECT * FROM api_tokens WHERE token_hash = ?")
        .bind(newToken)
        .first();
      expect(rawInDb).toBeNull();

      // Test that this newly created token can authenticate /v1/me
      const meRes = await app.request(
        "/v1/me",
        {
          headers: { Authorization: `Bearer ${newToken}` }
        },
        env
      );
      expect(meRes.status).toBe(200);
      const meBody = await meRes.json() as any;
      expect(meBody.handle).toBe("alexdev");

      // Revoke the token
      const deleteRes = await app.request(
        `/v1/tokens/${createBody.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${validToken}` }
        },
        env
      );
      expect(deleteRes.status).toBe(200);

      // Verify the revoked token can no longer authenticate
      const revokedMeRes = await app.request(
        "/v1/me",
        {
          headers: { Authorization: `Bearer ${newToken}` }
        },
        env
      );
      expect(revokedMeRes.status).toBe(401);
    });

    it("returns 400 when creating token with invalid name", async () => {
      const res = await app.request(
        "/v1/tokens",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${validToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: "   " })
        },
        env
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /v1/auth/logout", () => {
    it("deletes session from database and clears cookie", async () => {
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      await mockDb.prepare(
        "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
      ).bind("ses_to_logout", "usr_alexdev", expiresAt, new Date().toISOString()).run();

      const res = await app.request(
        "/v1/auth/logout",
        {
          method: "POST",
          headers: { Cookie: "skillapt_session=ses_to_logout" }
        },
        env
      );

      expect(res.status).toBe(200);

      const inDb = await mockDb.prepare("SELECT * FROM sessions WHERE id = ?")
        .bind("ses_to_logout")
        .first();
      expect(inDb).toBeNull();
    });
  });
});
