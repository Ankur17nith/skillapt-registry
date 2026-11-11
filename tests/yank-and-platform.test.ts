import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { resetRateLimits } from "../src/middleware/rate-limit";
import type { Env } from "../src/types";

describe("Yank, Abuse Reports, Rate Limits, and Stats", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  // alexdev token (owner of pdf-summarizer)
  const alexToken = "apt_live_testtoken1234567890abcdef";
  // sarahai token (not owner of pdf-summarizer)
  const sarahToken = "apt_live_sarahtoken1234567890abcdef";

  beforeEach(async () => {
    resetRateLimits();
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    // Seed sarah's token into DB
    await mockDb.prepare(
      "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind(
      "tok_demo_sarah",
      "usr_sarahai",
      "cli-laptop",
      "apt_live_sara",
      "f140f102f06afe2a460be2360d59217ea0653fa7fbc90dd7eb55baf2de5111eb",
      new Date().toISOString()
    ).run();

    // Put mock tarball in R2 for download test
    await mockStorage.put("skills/pdf-summarizer/1.2.0.tgz", "MOCK_BYTES");

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test"
    };
  });

  describe("POST /v1/skills/:name/:version/yank", () => {
    it("allows owner to yank a version, hiding it from latest resolution while preserving download", async () => {
      // Prior to yank, latest version of pdf-summarizer is 1.2.0
      const detailBefore = await app.request("/v1/skills/pdf-summarizer", {}, env);
      const bodyBefore = await detailBefore.json() as any;
      expect(bodyBefore.latestVersion).toBe("1.2.0");

      // Owner yanks 1.2.0
      const yankRes = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Vulnerability in extraction engine" })
        },
        env
      );

      expect(yankRes.status).toBe(200);
      const yankBody = await yankRes.json() as any;
      expect(yankBody.yanked).toBe(true);

      // Now latestVersion should fallback to 1.1.0!
      const detailAfter = await app.request("/v1/skills/pdf-summarizer", {}, env);
      const bodyAfter = await detailAfter.json() as any;
      expect(bodyAfter.latestVersion).toBe("1.1.0");
      expect(bodyAfter.versions["1.2.0"].yanked).toBe(true);

      // Direct download of exact version 1.2.0 STILL succeeds!
      const downloadRes = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {}, env);
      expect(downloadRes.status).toBe(200);
    });

    it("rejects yank requests from non-owners (403 Forbidden)", async () => {
      const res = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sarahToken}` }
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("POST /v1/reports", () => {
    it("accepts valid abuse and malware reports", async () => {
      const res = await app.request(
        "/v1/reports",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": "198.51.100.1"
          },
          body: JSON.stringify({
            skillName: "pdf-summarizer",
            version: "1.2.0",
            reason: "malware",
            details: "Contains unauthorized file scanner."
          })
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toMatch(/^rep_[a-f0-9]{16}$/);

      // Verify report in database
      const report = await mockDb.prepare("SELECT * FROM reports WHERE id = ?")
        .bind(body.id)
        .first<{ reason: string; details: string; reporter_ip: string | null; reporter_hash: string }>();

      expect(report).toBeDefined();
      expect(report?.reason).toBe("malware");
      expect(report?.reporter_ip).toBeUndefined();
      expect(report?.reporter_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("enforces rate limit of 5 reports per hour per IP", async () => {
      const payload = JSON.stringify({
        skillName: "pdf-summarizer",
        version: "1.2.0",
        reason: "spam",
        details: "Spam report"
      });

      // Send 5 reports from same IP
      for (let i = 0; i < 5; i++) {
        const res = await app.request(
          "/v1/reports",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "cf-connecting-ip": "203.0.113.42"
            },
            body: payload
          },
          env
        );
        expect(res.status).toBe(201);
      }

      // 6th report exceeds rate limit
      const rateLimitedRes = await app.request(
        "/v1/reports",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": "203.0.113.42"
          },
          body: payload
        },
        env
      );

      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.headers.get("Retry-After")).toBeDefined();
      const body = await rateLimitedRes.json() as any;
      expect(body.error.code).toBe("RATE_LIMITED");
    });
  });

  describe("GET /v1/stats", () => {
    it("returns accurate platform aggregates for the homepage", async () => {
      const res = await app.request("/v1/stats", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.totalSkills).toBe(20);
      expect(body.totalVersions).toBe(21); // 20 skills + pdf-summarizer has 2 versions = 21
      expect(body.totalAuthors).toBe(4);
      expect(body.totalDownloads).toBeGreaterThan(0);
    });
  });
});
