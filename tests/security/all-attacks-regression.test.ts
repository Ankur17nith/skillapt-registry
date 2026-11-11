import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { app } from "../../src/index";
import { MockD1Database } from "../helpers/mock-d1";
import { MockR2Bucket } from "../helpers/mock-r2";
import { buildTarGz } from "../helpers/tar-builder";
import { InMemoryRateLimiter } from "../../src/rate-limiter/do";
import { computeSha256 } from "../../src/utils/crypto";
import type { Env } from "../../src/types";

describe("Security: Comprehensive Regression Invariants", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  const alexToken = "apt_live_testtoken1234567890abcdef";
  const sarahToken = "apt_live_sarahtoken1234567890abcdef";
  const rawSession = "ses_regression_user_session";

  beforeEach(async () => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    // Create session for usr_alexdev
    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    await mockDb.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).bind(sessionHash, "usr_alexdev", expiresAt, new Date().toISOString()).run();

    // Insert Sarah's token
    const sarahHash = await computeSha256(new TextEncoder().encode(sarahToken));
    await mockDb.prepare(
      "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind("tok_reg_sarah", "usr_sarahai", "sarah-token", "apt_live_sara", sarahHash, new Date().toISOString()).run();

    // Claim scopes for alexdev and sarahai
    await mockDb.prepare(
      "INSERT OR REPLACE INTO scopes (scope, owner_id, github_id, created_at) VALUES (?, ?, ?, ?)"
    ).bind("alexdev", "usr_alexdev", 10101, new Date().toISOString()).run();

    await mockDb.prepare(
      "INSERT OR REPLACE INTO scopes (scope, owner_id, github_id, created_at) VALUES (?, ?, ?, ?)"
    ).bind("sarahai", "usr_sarahai", 20202, new Date().toISOString()).run();

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test",
      RATE_LIMITER: new InMemoryRateLimiter(),
      REPORT_SALT: "regression-salt-secret"
    };
  });

  function makePayload(name: string, version: string, extraFiles: { path: string; content: string | Uint8Array }[] = []) {
    const manifest = {
      name,
      version,
      description: "A secure regression test package.",
      license: "MIT",
      category: "coding",
      compatibility: ["claude"],
      permissions: { network: false, shell: false, filesystem: "none" }
    };
    const skillMd = `---\nname: ${name.startsWith("@") ? name.split("/")[1] : name}\ndescription: A secure regression test package.\n---\n# ${name}`;

    return buildTarGz([
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "SKILL.md", content: skillMd },
      ...extraFiles
    ]);
  }

  it("1. asserts migrations/ contains no 'INSERT INTO api_tokens' statements", () => {
    const migrationsDir = path.resolve(__dirname, "../../migrations");
    const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

    expect(sqlFiles.length).toBeGreaterThan(0);

    const tokenInsertRegex = /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+api_tokens/i;
    for (const file of sqlFiles) {
      const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      expect(
        tokenInsertRegex.test(content),
        `Migration file ${file} MUST NOT contain INSERT INTO api_tokens`
      ).toBe(false);
    }
  });

  it("2. rejects duplicate publish of the exact same version with 409 Conflict", async () => {
    const payload = makePayload("test-dup-skill", "1.0.0");

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

    // Duplicate publish fails with 409
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

  it("3. rejects invalid scope publish with 403 Forbidden", async () => {
    // Sarah trying to publish under Alex's scope (@alexdev/tool)
    const payload = makePayload("@alexdev/stolen-tool", "1.0.0");
    const res = await app.request("/v1/skills", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sarahToken}`,
        "Content-Type": "application/gzip"
      },
      body: payload
    }, env);

    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("4. rejects reserved name publish with 400 Bad Request", async () => {
    const payload = makePayload("claude", "1.0.0");
    const res = await app.request("/v1/skills", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alexToken}`,
        "Content-Type": "application/gzip"
      },
      body: payload
    }, env);

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error.code).toBe("INVALID_PACKAGE");
    expect(data.error.message).toContain("reserved");
  });

  it("5. rejects path traversal in tar with 400 Bad Request", async () => {
    const payload = makePayload("traversal-skill", "1.0.0", [
      { path: "../etc/passwd", content: "root:x:0:0" }
    ]);
    const res = await app.request("/v1/skills", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alexToken}`,
        "Content-Type": "application/gzip"
      },
      body: payload
    }, env);

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error.code).toBe("INVALID_PACKAGE");
    expect(data.error.message).toContain("traversal");
  });

  it("6. rejects executable magic bytes disguised with allowed extensions with 400", async () => {
    // ELF executable inside run.py
    const elfBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const payload = makePayload("magic-elf-skill", "1.0.0", [
      { path: "run.py", content: elfBytes }
    ]);

    const res = await app.request("/v1/skills", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alexToken}`,
        "Content-Type": "application/gzip"
      },
      body: payload
    }, env);

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error.code).toBe("INVALID_PACKAGE");
    expect(data.error.message).toContain("ELF");
  });

  it("7. rejects hostile Origin on cookie session mutating request with 403 CSRF_VIOLATION", async () => {
    const res = await app.request("/v1/tokens", {
      method: "POST",
      headers: {
        Cookie: `skillapt_session=${rawSession}`,
        Origin: "https://evil-attacker.com",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: "hacked-token" })
    }, env);

    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error.code).toBe("CSRF_VIOLATION");
  });

  it("8. rejects Bearer token minting via an existing Bearer token with 403", async () => {
    const res = await app.request("/v1/tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alexToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: "secondary-token" })
    }, env);

    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error.code).toBe("FORBIDDEN");
    expect(data.error.message).toContain("session");
  });

  it("9. returns 410 Gone with Cache-Control: no-store on removed version download", async () => {
    // Takedown pdf-summarizer@1.2.0
    await mockDb.prepare("UPDATE skill_versions SET status = 'removed', removal_reason = 'Abuse' WHERE skill_name = 'pdf-summarizer' AND version = '1.2.0'").run();

    const res = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {}, env);
    expect(res.status).toBe(410);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const data = await res.json() as any;
    expect(data.status).toBe("removed");
    expect(data.removed).toBe(true);
    expect(data.removalReason).toBe("Abuse");
  });

  it("10. rejects takedown requests by non-admin with 403 Forbidden", async () => {
    const res = await app.request("/v1/admin/skills/pdf-summarizer/1.2.0/takedown", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sarahToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ reason: "malicious" })
    }, env);

    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("11. deduplicates download counts from same IP on same day", async () => {
    await mockStorage.put("skills/test-dedupe-pkg/1.0.0.tgz", "TARBALL_CONTENT");
    await mockDb.prepare(`
      INSERT INTO skills (name, owner_id, latest_version, description, license, category, keywords, compatibility, downloads, verified, created_at, updated_at)
      VALUES ('test-dedupe-pkg', 'usr_alexdev', '1.0.0', 'Dedupe test pkg', 'MIT', 'coding', '[]', '["claude"]', 0, 0, datetime('now'), datetime('now'))
    `).run();
    await mockDb.prepare(`
      INSERT INTO skill_versions (id, skill_name, version, sha256, size, tarball_path, status, yanked, permissions, published_by, published_at)
      VALUES ('test-dedupe-pkg@1.0.0', 'test-dedupe-pkg', '1.0.0', 'fake-sha', 100, 'skills/test-dedupe-pkg/1.0.0.tgz', 'active', 0, '{}', 'usr_alexdev', datetime('now'))
    `).run();

    const clientIp = "198.51.100.222";

    // Download 1
    const res1 = await app.request("/v1/skills/test-dedupe-pkg/-/1.0.0.tgz", {
      headers: { "cf-connecting-ip": clientIp }
    }, env);
    expect(res1.status).toBe(200);

    const row1 = await mockDb.prepare("SELECT downloads FROM skills WHERE name = 'test-dedupe-pkg'")
      .first<{ downloads: number }>();
    expect(row1?.downloads).toBe(1);

    // Download 2 from SAME IP
    const res2 = await app.request("/v1/skills/test-dedupe-pkg/-/1.0.0.tgz", {
      headers: { "cf-connecting-ip": clientIp }
    }, env);
    expect(res2.status).toBe(200);

    const row2 = await mockDb.prepare("SELECT downloads FROM skills WHERE name = 'test-dedupe-pkg'")
      .first<{ downloads: number }>();
    expect(row2?.downloads).toBe(1); // STILL 1!
  });
});
