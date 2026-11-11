import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { resetRateLimits } from "../src/middleware/rate-limit";
import type { Env } from "../src/types";

describe("Branch 4: Takedown, Version Status, and Admin Routes", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  // Alex is owner of pdf-summarizer (role: 'user')
  const alexToken = "apt_live_testtoken1234567890abcdef";
  // Sarah is another user (role: 'user')
  const sarahToken = "apt_live_sarahtoken1234567890abcdef";
  // Admin user token (role: 'admin')
  const adminToken = "apt_live_admintoken1234567890abcdef";

  beforeEach(async () => {
    resetRateLimits();
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    // Seed sarah's token
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

    // Create an admin user and admin token
    const now = new Date().toISOString();
    await mockDb.prepare(
      "INSERT INTO users (id, github_id, handle, name, email, avatar_url, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      "usr_superadmin",
      999999,
      "superadmin",
      "Super Admin",
      "admin@skillapt.dev",
      "https://avatars.githubusercontent.com/u/999999",
      "admin",
      now,
      now
    ).run();

    // Hash of adminToken: sha256("apt_live_admintoken1234567890abcdef")
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminToken));
    const adminTokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await mockDb.prepare(
      "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind(
      "tok_demo_admin",
      "usr_superadmin",
      "admin-cli",
      "apt_live_admi",
      adminTokenHash,
      new Date().toISOString()
    ).run();

    // Put mock tarball in R2 for pdf-summarizer 1.2.0
    await mockStorage.put("skills/pdf-summarizer/1.2.0.tgz", "MOCK_BYTES_PDF_SUMMARIZER_1_2_0");

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test"
    };
  });

  describe("Yank idempotency and reason validation", () => {
    it("POST /v1/skills/:name/:version/yank is idempotent", async () => {
      // First yank
      const res1 = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Security patch in progress" })
        },
        env
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as any;
      expect(body1.yanked).toBe(true);

      // Retry yank (idempotent, does not toggle to false)
      const res2 = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Retry yank" })
        },
        env
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as any;
      expect(body2.yanked).toBe(true);

      // Verify DB status
      const row = await mockDb.prepare("SELECT yanked, status FROM skill_versions WHERE skill_name = 'pdf-summarizer' AND version = '1.2.0'").first<any>();
      expect(row.yanked).toBe(1);
      expect(row.status).toBe("yanked");
    });

    it("DELETE /v1/skills/:name/:version/yank un-yanks idempotently", async () => {
      // First yank
      await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${alexToken}` }
        },
        env
      );

      // Un-yank via DELETE
      const unyankRes1 = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${alexToken}` }
        },
        env
      );
      expect(unyankRes1.status).toBe(200);
      const unyankBody1 = (await unyankRes1.json()) as any;
      expect(unyankBody1.yanked).toBe(false);

      // Retry DELETE (idempotent)
      const unyankRes2 = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${alexToken}` }
        },
        env
      );
      expect(unyankRes2.status).toBe(200);
      const unyankBody2 = (await unyankRes2.json()) as any;
      expect(unyankBody2.yanked).toBe(false);
    });

    it("rejects yank reason longer than 500 characters with 400 BAD_REQUEST", async () => {
      const longReason = "a".repeat(501);
      const res = await app.request(
        "/v1/skills/pdf-summarizer/1.2.0/yank",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: longReason })
        },
        env
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("500");
    });
  });

  describe("Admin Takedown and Restore", () => {
    it("rejects non-admin takedown requests with 403 FORBIDDEN", async () => {
      const res = await app.request(
        "/v1/admin/skills/pdf-summarizer/1.2.0/takedown",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Malware detected" })
        },
        env
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("executes admin takedown, writes audit_log, and updates version status", async () => {
      const res = await app.request(
        "/v1/admin/skills/pdf-summarizer/1.2.0/takedown",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Malware payload identified" })
        },
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("removed");

      // Verify audit_log entry
      const audit = await mockDb.prepare("SELECT * FROM audit_log WHERE target = 'pdf-summarizer@1.2.0'").first<any>();
      expect(audit).toBeDefined();
      expect(audit.action).toBe("skill_version.takedown");
      expect(audit.actor_id).toBe("usr_superadmin");
      expect(audit.detail).toContain("Malware payload identified");
    });

    it("returns 410 Gone with Cache-Control: no-store when downloading removed version", async () => {
      // Takedown 1.2.0
      await app.request(
        "/v1/admin/skills/pdf-summarizer/1.2.0/takedown",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Critical vulnerability CVE-2026-9999" })
        },
        env
      );

      // Download attempt
      const dlRes = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {}, env);
      expect(dlRes.status).toBe(410);
      expect(dlRes.headers.get("Cache-Control")).toBe("no-store");
      const dlBody = (await dlRes.json()) as any;
      expect(dlBody.error.code).toBe("GONE");
      expect(dlBody.removed).toBe(true);
      expect(dlBody.removalReason).toBe("Critical vulnerability CVE-2026-9999");
    });

    it("reflects status: 'removed', removed: true, removalReason, and omits tarballUrl in metadata", async () => {
      // Takedown 1.2.0
      await app.request(
        "/v1/admin/skills/pdf-summarizer/1.2.0/takedown",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "Prompt injection vector" })
        },
        env
      );

      // GET /v1/skills/pdf-summarizer
      const skillRes = await app.request("/v1/skills/pdf-summarizer", {}, env);
      expect(skillRes.status).toBe(200);
      const skillBody = (await skillRes.json()) as any;
      expect(skillBody.latestVersion).toBe("1.1.0"); // Excluded from latest_version!

      const v120 = skillBody.versions["1.2.0"];
      expect(v120.status).toBe("removed");
      expect(v120.removed).toBe(true);
      expect(v120.removalReason).toBe("Prompt injection vector");
      expect(v120.tarballUrl).toBeUndefined();

      // GET /v1/skills/pdf-summarizer/1.2.0
      const exactRes = await app.request("/v1/skills/pdf-summarizer/1.2.0", {}, env);
      expect(exactRes.status).toBe(200);
      const exactBody = (await exactRes.json()) as any;
      expect(exactBody.status).toBe("removed");
      expect(exactBody.removed).toBe(true);
      expect(exactBody.removalReason).toBe("Prompt injection vector");
      expect(exactBody.tarballUrl).toBeUndefined();
    });

    it("restores removed version, writes audit_log, and re-enables download", async () => {
      // Takedown
      await app.request(
        "/v1/admin/skills/pdf-summarizer/1.2.0/takedown",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        env
      );

      // Restore
      const restoreRes = await app.request(
        "/v1/admin/skills/pdf-summarizer/1.2.0/restore",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        env
      );
      expect(restoreRes.status).toBe(200);
      const restoreBody = (await restoreRes.json()) as any;
      expect(restoreBody.status).toBe("active");

      // Verify audit_log
      const audit = await mockDb.prepare("SELECT * FROM audit_log WHERE target = 'pdf-summarizer@1.2.0' AND action = 'skill_version.restore'").first<any>();
      expect(audit).toBeDefined();

      // Download now succeeds again
      const dlRes = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {}, env);
      expect(dlRes.status).toBe(200);
    });

    it("supports listing and resolving abuse reports with audit logging", async () => {
      // Create a report
      const repRes = await app.request(
        "/v1/reports",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": "198.51.100.99"
          },
          body: JSON.stringify({
            skillName: "pdf-summarizer",
            version: "1.2.0",
            reason: "malware",
            details: "Contains backdoor payload"
          })
        },
        env
      );
      expect(repRes.status).toBe(201);
      const repBody = (await repRes.json()) as any;
      const reportId = repBody.id;

      // Admin lists reports
      const listRes = await app.request(
        "/v1/admin/reports?status=pending",
        {
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        env
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as any;
      expect(listBody.reports.length).toBeGreaterThanOrEqual(1);

      // Admin resolves report
      const resolveRes = await app.request(
        `/v1/admin/reports/${reportId}/resolve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ notes: "Verified clean after patch" })
        },
        env
      );
      expect(resolveRes.status).toBe(200);

      // Verify audit_log
      const audit = await mockDb.prepare("SELECT * FROM audit_log WHERE target = ? AND action = 'report.resolve'").bind(reportId).first<any>();
      expect(audit).toBeDefined();
      expect(audit.actor_id).toBe("usr_superadmin");
    });
  });
});
