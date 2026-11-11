import { describe, it, expect, beforeEach, vi } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { InMemoryRateLimiter } from "../src/rate-limiter/do";
import { computeSha256 } from "../src/utils/crypto";
import type { Env } from "../src/types";

describe("Branch 8: Search, Download, and Abuse Reports Hardening", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  const alexToken = "apt_live_testtoken1234567890abcdef";

  beforeEach(async () => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    // Ensure mock tarball is present in R2
    await mockStorage.put("skills/pdf-summarizer/1.2.0.tgz", "TARBALL_1_2_0_CONTENT");
    await mockStorage.put("skills/pdf-summarizer/1.1.0.tgz", "TARBALL_1_1_0_CONTENT");

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test",
      RATE_LIMITER: new InMemoryRateLimiter(),
      REPORT_SALT: "test-salt-secret"
    };
  });

  describe("1. Search: LIKE Escaping, Param Validation, and N+1 Elimination", () => {
    it("escapes LIKE wildcards (% and _) in query parameter to produce literal matches", async () => {
      // Seed two skills with similar names
      const now = new Date().toISOString();
      await mockDb.prepare(`
        INSERT INTO skills (name, owner_id, description, license, category, keywords, compatibility, downloads, verified, created_at, updated_at, latest_version)
        VALUES 
          ('calc%tool', 'usr_alexdev', 'Calculator with % in name', 'MIT', 'devtools', '["calc"]', '["claude"]', 10, 0, ?, ?, '1.0.0'),
          ('calctool', 'usr_alexdev', 'Calculator without percent', 'MIT', 'devtools', '["calc"]', '["claude"]', 20, 0, ?, ?, '1.0.0'),
          ('test_skill', 'usr_alexdev', 'Test with underscore', 'MIT', 'devtools', '["test"]', '["claude"]', 30, 0, ?, ?, '1.0.0'),
          ('test1skill', 'usr_alexdev', 'Test with 1', 'MIT', 'devtools', '["test"]', '["claude"]', 40, 0, ?, ?, '1.0.0')
      `).bind(now, now, now, now, now, now, now, now).run();

      // Search for literal '%'
      const percentRes = await app.request("/v1/skills?q=calc%25tool", {}, env);
      expect(percentRes.status).toBe(200);
      const percentData = await percentRes.json() as any;
      expect(percentData.skills).toHaveLength(1);
      expect(percentData.skills[0].name).toBe("calc%tool");

      // Search for literal '_'
      const underscoreRes = await app.request("/v1/skills?q=test_skill", {}, env);
      expect(underscoreRes.status).toBe(200);
      const underscoreData = await underscoreRes.json() as any;
      expect(underscoreData.skills).toHaveLength(1);
      expect(underscoreData.skills[0].name).toBe("test_skill");
    });

    it("eliminates N+1 queries during search (asserts DB query count <= 2)", async () => {
      let queryCount = 0;
      const originalPrepare = mockDb.prepare.bind(mockDb);
      mockDb.prepare = ((query: string) => {
        queryCount++;
        return originalPrepare(query);
      }) as typeof mockDb.prepare;

      const res = await app.request("/v1/skills?limit=20", {}, env);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.skills.length).toBeGreaterThan(0);
      expect(data.skills[0].latestVersion).toBeDefined();

      // Exactly 1 count query + 1 paginated select query
      expect(queryCount).toBeLessThanOrEqual(2);
    });

    it("validates sort and category parameters and rejects invalid values with 400", async () => {
      const badSortRes = await app.request("/v1/skills?sort=popularity", {}, env);
      expect(badSortRes.status).toBe(400);
      const badSortData = await badSortRes.json() as any;
      expect(badSortData.error.code).toBe("BAD_REQUEST");
      expect(badSortData.error.message).toContain("sort");

      const badCategoryRes = await app.request("/v1/skills?category=gaming", {}, env);
      expect(badCategoryRes.status).toBe(400);
      const badCategoryData = await badCategoryRes.json() as any;
      expect(badCategoryData.error.code).toBe("BAD_REQUEST");
      expect(badCategoryData.error.message).toContain("category");

      // Valid parameters succeed
      const validRes = await app.request("/v1/skills?sort=updated&category=coding", {}, env);
      expect(validRes.status).toBe(200);
    });
  });

  describe("2. Download: Streaming, ETag / If-None-Match, Cache-Control, and Deduplication", () => {
    it("handles If-None-Match matching ETag / sha256 and returns 304 Not Modified", async () => {
      const sha = "0f6fca4a57687bd3e4fb4b54d4c25eff32239a5a869595b2189bb5df3ec664a1";

      // Match quoted ETag
      const res1 = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {
        headers: { "If-None-Match": `"${sha}"` }
      }, env);
      expect(res1.status).toBe(304);
      expect(res1.headers.get("ETag")).toBe(`"${sha}"`);
      expect(res1.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

      // Match raw sha
      const res2 = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {
        headers: { "If-None-Match": sha }
      }, env);
      expect(res2.status).toBe(304);

      // Mismatch ETag returns 200 with streamed content
      const res3 = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {
        headers: { "If-None-Match": "\"different-sha\"" }
      }, env);
      expect(res3.status).toBe(200);
      expect(await res3.text()).toBe("TARBALL_1_2_0_CONTENT");
    });

    it("returns short Cache-Control max-age=300 for yanked versions", async () => {
      // Mark 1.1.0 as yanked
      await mockDb.prepare("UPDATE skill_versions SET yanked = 1 WHERE skill_name = ? AND version = ?")
        .bind("pdf-summarizer", "1.1.0").run();

      const res = await app.request("/v1/skills/pdf-summarizer/-/1.1.0.tgz", {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    });

    it("deduplicates download counts per (skill, version, ip_hash, day) and skips HEAD / Range", async () => {
      const skillName = "pdf-summarizer";
      const version = "1.2.0";

      const getDownloads = async () => {
        const row = await mockDb.prepare("SELECT downloads FROM skills WHERE name = ?")
          .bind(skillName).first<{ downloads: number }>();
        return row?.downloads ?? 0;
      };

      const initialDownloads = await getDownloads();

      // First download from IP 198.51.100.99 -> increments count
      const res1 = await app.request(`/v1/skills/${skillName}/-/${version}.tgz`, {
        headers: { "cf-connecting-ip": "198.51.100.99" }
      }, env);
      expect(res1.status).toBe(200);
      expect(await getDownloads()).toBe(initialDownloads + 1);

      // Second download from SAME IP on same day -> deduplicated, does NOT increment count
      const res2 = await app.request(`/v1/skills/${skillName}/-/${version}.tgz`, {
        headers: { "cf-connecting-ip": "198.51.100.99" }
      }, env);
      expect(res2.status).toBe(200);
      expect(await getDownloads()).toBe(initialDownloads + 1);

      // Third download from DIFFERENT IP -> increments count
      const res3 = await app.request(`/v1/skills/${skillName}/-/${version}.tgz`, {
        headers: { "cf-connecting-ip": "198.51.100.100" }
      }, env);
      expect(res3.status).toBe(200);
      expect(await getDownloads()).toBe(initialDownloads + 2);

      // HEAD request -> does NOT increment count
      const headRes = await app.request(`/v1/skills/${skillName}/-/${version}.tgz`, {
        method: "HEAD",
        headers: { "cf-connecting-ip": "198.51.100.101" }
      }, env);
      expect(headRes.status).toBe(200);
      expect(await getDownloads()).toBe(initialDownloads + 2);

      // Range request -> does NOT increment count
      const rangeRes = await app.request(`/v1/skills/${skillName}/-/${version}.tgz`, {
        headers: {
          "cf-connecting-ip": "198.51.100.102",
          Range: "bytes=0-100"
        }
      }, env);
      expect(rangeRes.status).toBe(200);
      expect(await getDownloads()).toBe(initialDownloads + 2);
    });
  });

  describe("3. Reports: Length Validation, Version Existence, and Reporter Hashing", () => {
    it("rejects non-existent version with 400 and accepts valid version or wildcard *", async () => {
      // Non-existent version
      const badVerRes = await app.request("/v1/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillName: "pdf-summarizer",
          version: "99.0.0",
          reason: "malware",
          details: "Suspicious activity detected"
        })
      }, env);
      expect(badVerRes.status).toBe(400);
      const badVerData = await badVerRes.json() as any;
      expect(badVerData.error.message).toContain("does not exist");

      // Valid existing version 1.2.0
      const okVerRes = await app.request("/v1/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillName: "pdf-summarizer",
          version: "1.2.0",
          reason: "malware",
          details: "Confirmed malware"
        })
      }, env);
      expect(okVerRes.status).toBe(201);

      // Wildcard version *
      const wildcardRes = await app.request("/v1/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillName: "pdf-summarizer",
          version: "*",
          reason: "abusive",
          details: "Abusive package overall"
        })
      }, env);
      expect(wildcardRes.status).toBe(201);
    });

    it("rejects details exceeding 2000 characters with 400", async () => {
      const longDetails = "a".repeat(2001);
      const res = await app.request("/v1/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillName: "pdf-summarizer",
          version: "1.2.0",
          reason: "spam",
          details: longDetails
        })
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("2000 characters");
    });

    it("hashes reporter IP using sha256(clientIp + salt) and returns reporter_hash in admin reports", async () => {
      const clientIp = "192.0.2.77";
      const salt = "test-salt-secret";
      const expectedHash = await computeSha256(new TextEncoder().encode(clientIp + salt));

      const reportRes = await app.request("/v1/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": clientIp
        },
        body: JSON.stringify({
          skillName: "pdf-summarizer",
          version: "1.2.0",
          reason: "license_violation",
          details: "License infringement reported"
        })
      }, env);

      expect(reportRes.status).toBe(201);
      const reportBody = await reportRes.json() as any;
      const reportId = reportBody.id;

      // Verify row in DB: reporter_hash matches and reporter_ip is dropped
      const row = await mockDb.prepare("SELECT * FROM reports WHERE id = ?")
        .bind(reportId).first<any>();
      expect(row.reporter_hash).toBe(expectedHash);
      expect(row.reporter_ip).toBeUndefined();

      // Make alexdev an admin and check GET /v1/admin/reports
      await mockDb.prepare("UPDATE users SET role = 'admin' WHERE id = 'usr_alexdev'").run();

      const adminRes = await app.request("/v1/admin/reports", {
        headers: { Authorization: `Bearer ${alexToken}` }
      }, env);
      expect(adminRes.status).toBe(200);
      const adminData = await adminRes.json() as any;
      const foundReport = adminData.reports.find((r: any) => r.id === reportId);
      expect(foundReport).toBeDefined();
      expect(foundReport.reporter_hash).toBe(expectedHash);
      expect(foundReport.reporter_ip).toBeUndefined();
    });
  });
});
