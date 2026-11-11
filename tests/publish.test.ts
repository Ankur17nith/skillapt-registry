import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { buildTarGz } from "./helpers/tar-builder";
import type { Env } from "../src/types";
import { InMemoryRateLimiter } from "../src/rate-limiter/do";

describe("Publish Endpoint (POST /v1/skills)", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  // Pre-seeded token in seed.sql: 'usr_alexdev'
  const alexToken = "apt_live_testtoken1234567890abcdef";

  // Create another token for 'usr_sarahai'
  const sarahToken = "apt_live_sarahtoken1234567890abcdef";

  const sampleManifest = {
    name: "new-super-skill",
    version: "1.0.0",
    description: "An innovative AI agent skill for automated testing.",
    license: "MIT",
    category: "coding",
    compatibility: ["claude", "cursor"],
    dependencies: {
      "text-cleaner": "^1.0.0"
    },
    permissions: {
      network: false,
      shell: false,
      filesystem: "read"
    }
  };

  const sampleSkillMd = `---
name: new-super-skill
description: An innovative AI agent skill for automated testing.
---
# New Super Skill

Automates tests for AI agents.`;

  beforeEach(async () => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    // Seed sarah's token into DB
    // sha256('apt_live_sarahtoken1234567890abcdef') = 'f140f102f06afe2a460be2360d59217ea0653fa7fbc90dd7eb55baf2de5111eb'
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

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test",
      RATE_LIMITER: new InMemoryRateLimiter()
    };
  });

  it("returns 401 Unauthorized when publishing without authentication", async () => {
    const tarGz = buildTarGz([
      { path: "skill.json", content: JSON.stringify(sampleManifest) },
      { path: "SKILL.md", content: sampleSkillMd }
    ]);

    const res = await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: tarGz
      },
      env
    );

    expect(res.status).toBe(401);
  });

  it("successfully publishes a new skill package and assigns ownership", async () => {
    const tarGz = buildTarGz([
      { path: "skill.json", content: JSON.stringify(sampleManifest) },
      { path: "SKILL.md", content: sampleSkillMd }
    ]);

    const formData = new FormData();
    const blob = new Blob([tarGz], { type: "application/gzip" });
    formData.append("file", blob, "package.tar.gz");

    const res = await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`
        },
        body: formData
      },
      env
    );

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe("new-super-skill");
    expect(body.version).toBe("1.0.0");
    expect(body.sha256).toBeDefined();
    expect(body.tarballUrl).toContain("/v1/skills/new-super-skill/-/1.0.0.tgz");

    // Verify database record
    const skillRow = await mockDb.prepare("SELECT owner_id, category FROM skills WHERE name = ?")
      .bind("new-super-skill")
      .first<{ owner_id: string; category: string }>();

    expect(skillRow).toBeDefined();
    expect(skillRow?.owner_id).toBe("usr_alexdev"); // First publisher becomes owner
    expect(skillRow?.category).toBe("coding");

    // Verify R2 storage
    const r2Obj = await mockStorage.get("skills/new-super-skill/1.0.0.tgz");
    expect(r2Obj).not.toBeNull();
  });

  it("allows the owner to publish a subsequent version (1.1.0)", async () => {
    // 1. Publish 1.0.0
    const tarGz1 = buildTarGz([
      { path: "skill.json", content: JSON.stringify(sampleManifest) },
      { path: "SKILL.md", content: sampleSkillMd }
    ]);

    await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz1
      },
      env
    );

    // 2. Publish 1.1.0
    const manifestV2 = { ...sampleManifest, version: "1.1.0" };
    const tarGz2 = buildTarGz([
      { path: "skill.json", content: JSON.stringify(manifestV2) },
      { path: "SKILL.md", content: sampleSkillMd }
    ]);

    const res = await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz2
      },
      env
    );

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.version).toBe("1.1.0");

    const versions = await mockDb.prepare("SELECT version FROM skill_versions WHERE skill_name = ?")
      .bind("new-super-skill")
      .all<{ version: string }>();

    expect(versions.results.map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);
  });

  it("enforces version immutability (returns 409 Conflict on republishing same version)", async () => {
    const tarGz = buildTarGz([
      { path: "skill.json", content: JSON.stringify(sampleManifest) },
      { path: "SKILL.md", content: sampleSkillMd }
    ]);

    // First publish succeeds
    await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      },
      env
    );

    // Attempting republish of 1.0.0
    const duplicateRes = await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      },
      env
    );

    expect(duplicateRes.status).toBe(409);
    const body = await duplicateRes.json() as any;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("immutable");
  });

  it("prevents non-owners from publishing new versions of existing packages (403 Forbidden)", async () => {
    // pdf-summarizer is owned by alexdev in seed.sql
    // Attempt to publish 2.0.0 with sarah's token
    const newVersionManifest = {
      name: "pdf-summarizer",
      version: "2.0.0",
      description: "Attempted hijacking by another author.",
      license: "MIT",
      category: "documents",
      compatibility: ["claude"],
      permissions: { network: false, shell: false, filesystem: "none" }
    };

    const tarGz = buildTarGz([
      { path: "skill.json", content: JSON.stringify(newVersionManifest) },
      { path: "SKILL.md", content: "---\nname: pdf-summarizer\ndescription: Attempted hijacking by another author.\n---\n# Hijack" }
    ]);

    const res = await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sarahToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      },
      env
    );

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 when uploaded archive fails package validation", async () => {
    // Missing SKILL.md
    const badTarGz = buildTarGz([
      { path: "skill.json", content: JSON.stringify(sampleManifest) }
    ]);

    const res = await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: badTarGz
      },
      env
    );

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe("INVALID_PACKAGE");
  });
});
