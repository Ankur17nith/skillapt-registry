import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { buildTarGz } from "./helpers/tar-builder";
import type { Env } from "../src/types";

describe("Branch 3: Publish Atomicity, Limits, and Latest Version Maintenance", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  const alexToken = "apt_live_testtoken1234567890abcdef";

  beforeEach(async () => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test"
    };
  });

  function makeValidPayload(name: string, version: string, description: string = "Valid test description.") {
    const manifest = {
      name,
      version,
      description,
      license: "MIT",
      category: "coding",
      compatibility: ["claude"],
      dependencies: {},
      permissions: { network: false, shell: false, filesystem: "none" }
    };
    const skillMd = `---
name: ${name}
description: ${description}
---
# ${name}
Documentation for ${name}.`;

    return buildTarGz([
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "SKILL.md", content: skillMd }
    ]);
  }

  describe("1. Content-Length & Size-Capped Stream Limits", () => {
    it("rejects Content-Length > 5 MB with 413 before reading body", async () => {
      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip",
          "Content-Length": String(6 * 1024 * 1024) // 6 MB
        },
        body: new Uint8Array(10) // Small actual body
      }, env);

      expect(res.status).toBe(413);
      const data = await res.json() as any;
      expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("reads body through size-capped stream and rejects oversized payload (> 5 MB) with 413", async () => {
      const oversizedPayload = new Uint8Array(5 * 1024 * 1024 + 1024); // 5 MB + 1 KB

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: oversizedPayload
      }, env);

      expect(res.status).toBe(413);
      const data = await res.json() as any;
      expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("2. R2 Create-Only Semantics & Atomic D1 Pipeline", () => {
    it("returns 409 Conflict when attempting concurrent publish of the same version", async () => {
      const payload = makeValidPayload("atomic-skill", "1.0.0");

      // First publish succeeds
      const res1 = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: payload
      }, env);
      expect(res1.status).toBe(201);

      // Concurrent second publish of exact same version hits R2 create-only precondition
      const res2 = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: payload
      }, env);

      expect(res2.status).toBe(409);
      const data = await res2.json() as any;
      expect(data.error.code).toBe("CONFLICT");
    });

    it("cleans up R2 object on forced D1 batch failure leaving no orphan files", async () => {
      const payload = makeValidPayload("orphan-test-skill", "1.0.0");

      // Sabotage DB.batch by making it throw
      const originalBatch = mockDb.batch.bind(mockDb);
      mockDb.batch = async () => {
        throw new Error("Simulated D1 write failure during batch transaction");
      };

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: payload
      }, env);

      expect(res.status).toBe(500);
      const data = await res.json() as any;
      expect(data.error.code).toBe("INTERNAL_ERROR");

      // Verify R2 object was deleted and not left orphaned
      const r2Object = await mockStorage.get("skills/orphan-test-skill/1.0.0.tgz");
      expect(r2Object).toBeNull();

      // Restore batch
      mockDb.batch = originalBatch;
    });
  });

  describe("3. Highest Stable Version & latest_version Maintenance", () => {
    it("only updates skills metadata when published version is the highest stable version", async () => {
      // 1. Initial release 1.0.0 (stable)
      const p1 = makeValidPayload("versioned-tool", "1.0.0", "Initial 1.0.0 description.");
      const res1 = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: p1
      }, env);
      expect(res1.status).toBe(201);

      const skill1 = await mockDb.prepare("SELECT * FROM skills WHERE name = 'versioned-tool'").first<any>();
      expect(skill1.latest_version).toBe("1.0.0");
      expect(skill1.description).toBe("Initial 1.0.0 description.");

      // 2. Publish 2.0.0-beta.1 (prerelease): should NOT update description or latest_version
      const p2 = makeValidPayload("versioned-tool", "2.0.0-beta.1", "Prerelease beta description.");
      const res2 = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: p2
      }, env);
      expect(res2.status).toBe(201);

      const skill2 = await mockDb.prepare("SELECT * FROM skills WHERE name = 'versioned-tool'").first<any>();
      expect(skill2.latest_version).toBe("1.0.0");
      expect(skill2.description).toBe("Initial 1.0.0 description.");

      // 3. Publish 1.0.1 (patch of older stable): higher than 1.0.0, so updates latest_version to 1.0.1
      const p3 = makeValidPayload("versioned-tool", "1.0.1", "Patch 1.0.1 description.");
      const res3 = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: p3
      }, env);
      expect(res3.status).toBe(201);

      const skill3 = await mockDb.prepare("SELECT * FROM skills WHERE name = 'versioned-tool'").first<any>();
      expect(skill3.latest_version).toBe("1.0.1");
      expect(skill3.description).toBe("Patch 1.0.1 description.");

      // 4. Publish 2.0.0 (final stable): highest stable version, updates metadata
      const p4 = makeValidPayload("versioned-tool", "2.0.0", "Version 2.0.0 final release.");
      const res4 = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: p4
      }, env);
      expect(res4.status).toBe(201);

      const skill4 = await mockDb.prepare("SELECT * FROM skills WHERE name = 'versioned-tool'").first<any>();
      expect(skill4.latest_version).toBe("2.0.0");
      expect(skill4.description).toBe("Version 2.0.0 final release.");
    });

    it("maintains latest_version on yank and unyank", async () => {
      // Setup package with 1.0.0 and 2.0.0
      await app.request("/v1/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${alexToken}`, "Content-Type": "application/gzip" },
        body: makeValidPayload("yank-maint-tool", "1.0.0")
      }, env);
      await app.request("/v1/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${alexToken}`, "Content-Type": "application/gzip" },
        body: makeValidPayload("yank-maint-tool", "2.0.0")
      }, env);

      let row = await mockDb.prepare("SELECT latest_version FROM skills WHERE name = 'yank-maint-tool'").first<any>();
      expect(row.latest_version).toBe("2.0.0");

      // Yank 2.0.0 -> latest_version falls back to 1.0.0
      const yankRes = await app.request("/v1/skills/yank-maint-tool/2.0.0/yank", {
        method: "POST",
        headers: { Authorization: `Bearer ${alexToken}` }
      }, env);
      expect(yankRes.status).toBe(200);

      row = await mockDb.prepare("SELECT latest_version FROM skills WHERE name = 'yank-maint-tool'").first<any>();
      expect(row.latest_version).toBe("1.0.0");

      // Unyank 2.0.0 -> latest_version restored to 2.0.0
      const unyankRes = await app.request("/v1/skills/yank-maint-tool/2.0.0/yank", {
        method: "POST",
        headers: { Authorization: `Bearer ${alexToken}` }
      }, env);
      expect(unyankRes.status).toBe(200);

      row = await mockDb.prepare("SELECT latest_version FROM skills WHERE name = 'yank-maint-tool'").first<any>();
      expect(row.latest_version).toBe("2.0.0");
    });
  });

  describe("4. Integrity field: sha256-<hex>", () => {
    it("returns integrity: sha256-<hex> in publish, get skill, and get version responses", async () => {
      const payload = makeValidPayload("integrity-pkg", "1.0.0");

      // Publish response
      const pubRes = await app.request("/v1/skills", {
        method: "POST",
        headers: { Authorization: `Bearer ${alexToken}`, "Content-Type": "application/gzip" },
        body: payload
      }, env);
      expect(pubRes.status).toBe(201);
      const pubData = await pubRes.json() as any;
      expect(pubData.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(pubData.integrity).toBe(`sha256-${pubData.sha256}`);

      // GET /v1/skills/:name
      const skillRes = await app.request("/v1/skills/integrity-pkg", {}, env);
      expect(skillRes.status).toBe(200);
      const skillData = await skillRes.json() as any;
      expect(skillData.versions["1.0.0"].integrity).toBe(`sha256-${pubData.sha256}`);

      // GET /v1/skills/:name/:version
      const verRes = await app.request("/v1/skills/integrity-pkg/1.0.0", {}, env);
      expect(verRes.status).toBe(200);
      const verData = await verRes.json() as any;
      expect(verData.integrity).toBe(`sha256-${pubData.sha256}`);
    });
  });
});
