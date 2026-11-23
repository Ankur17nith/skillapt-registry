import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { buildTarGz } from "./helpers/tar-builder";
import { resetRateLimits } from "../src/middleware/rate-limit";
import type { Env } from "../src/types";

const alexToken = "apt_live_testtoken1234567890abcdef"; // usr_alexdev, github 10101
const sarahToken = "apt_live_sarahtoken1234567890abcdef"; // usr_sarahai
const adminToken = "apt_live_admintoken1234567890abcdef";

async function sha(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const crawled = (over: Record<string, unknown> = {}) => ({
  name: "@alexdev/pdf-tools",
  description: "Extract text and tables from PDF files for agents.",
  license: "MIT",
  category: "documents",
  keywords: ["PDF", "tables"],
  compatibility: ["claude", "not-a-real-target"],
  sourceUrl: "https://github.com/alexdev/skills",
  sourcePath: "pdf-tools",
  sourceSha: "abc1234",
  sourceOwner: "alexdev",
  ...over
});

describe("Crawled skills: ingest, ownership and claims", () => {
  let db: MockD1Database;
  let env: Env;

  const ingest = (skills: unknown[], token = adminToken) =>
    app.request(
      "/v1/admin/ingest",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ skills })
      },
      env
    );
  const claim = (name: string, token: string) =>
    app.request(
      `/v1/skills/${encodeURIComponent(name)}/claim`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      env
    );

  beforeEach(async () => {
    resetRateLimits();
    db = new MockD1Database();
    db.applyMigrations();
    db.applySeed();
    const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind("tok_sarah", "usr_sarahai", "t", "apt_live_sara", await sha(sarahToken), now).run();
    await db.prepare(
      "INSERT INTO users (id, github_id, handle, name, email, avatar_url, role, created_at, updated_at) VALUES ('usr_superadmin', 999999, 'superadmin', 'Admin', 'a@x.dev', '', 'admin', ?, ?)"
    ).bind(now, now).run();
    await db.prepare(
      "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind("tok_admin", "usr_superadmin", "t", "apt_live_admi", await sha(adminToken), now).run();
    env = { DB: db.asD1(), STORAGE: new MockR2Bucket().asR2(), ENVIRONMENT: "test" };
  });

  it("only admins can ingest", async () => {
    expect((await ingest([crawled()], alexToken)).status).toBe(403);
    expect((await app.request("/v1/admin/ingest", { method: "POST", body: "{}" }, env)).status).toBe(401);
  });

  it("ingests unclaimed listings owned by the system user, normalising fields", async () => {
    const res = await ingest([crawled()]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, updated: 0, rejected: [] });

    const row = await db.prepare("SELECT * FROM skills WHERE name = '@alexdev/pdf-tools'").first<any>();
    expect(row.owner_id).toBe("usr_crawler");
    expect(row.source).toBe("crawled");
    expect(row.claim_status).toBe("unclaimed");
    expect(JSON.parse(row.keywords)).toEqual(["pdf", "tables"]);
    expect(JSON.parse(row.compatibility)).toEqual(["claude"]);

    const detail = (await (await app.request("/v1/skills/%40alexdev%2Fpdf-tools", {}, env)).json()) as any;
    expect(detail).toMatchObject({
      source: "crawled",
      claimStatus: "unclaimed",
      sourceUrl: "https://github.com/alexdev/skills",
      sourcePath: "pdf-tools",
      sourceSha: "abc1234"
    });

    const search = await (await app.request("/v1/skills?q=pdf%20tables", {}, env)).json() as any;
    const hit = search.skills.find((s: any) => s.name === "@alexdev/pdf-tools");
    expect(hit.claimStatus).toBe("unclaimed");
    expect(hit.source).toBe("crawled");
  });

  it("is idempotent and refreshes unclaimed listings", async () => {
    await ingest([crawled()]);
    const res = await ingest([crawled({ description: "Updated description for the PDF tools.", sourceSha: "def5678" })]);
    expect(await res.json()).toMatchObject({ created: 0, updated: 1 });
    const row = await db.prepare("SELECT description, source_sha FROM skills WHERE name = '@alexdev/pdf-tools'").first<any>();
    expect(row.source_sha).toBe("def5678");
    expect(row.description).toContain("Updated");
  });

  it("rejects bad entries without failing the batch", async () => {
    const res = await ingest([
      crawled(),
      crawled({ name: "pdf-tools-unscoped" }),
      crawled({ name: "@someoneelse/pdf-tools" }),
      crawled({ name: "@alexdev/other", description: "short" }),
      crawled({ name: "@alexdev/http", sourceUrl: "http://insecure.example/x" })
    ]);
    const body = (await res.json()) as any;
    expect(body.created).toBe(1);
    expect(body.rejected).toHaveLength(4);
  });

  it("never overwrites a published skill with the same name", async () => {
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO skills (name, owner_id, description, license, category, keywords, compatibility, created_at, updated_at)
      VALUES ('@alexdev/pdf-tools', 'usr_alexdev', 'Published by the author.', 'MIT', 'documents', '[]', '["claude"]', ?, ?)
    `).bind(now, now).run();
    const body = (await (await ingest([crawled()])).json()) as any;
    expect(body.created).toBe(0);
    expect(body.rejected[0].reason).toBe("name taken");
  });

  it("lets the GitHub owner claim an unclaimed listing", async () => {
    await ingest([crawled()]);
    const res = await claim("@alexdev/pdf-tools", alexToken);
    expect(res.status).toBe(200);
    const row = await db.prepare("SELECT owner_id, claim_status FROM skills WHERE name = '@alexdev/pdf-tools'").first<any>();
    expect(row).toEqual({ owner_id: "usr_alexdev", claim_status: "claimed" });
    expect(
      await db.prepare("SELECT method, status FROM skill_claims WHERE skill_name = '@alexdev/pdf-tools'").first()
    ).toEqual({ method: "github-owner", status: "approved" });
    expect(await db.prepare("SELECT 1 AS x FROM audit_log WHERE action = 'skill.claim'").first()).toBeTruthy();

    // Once claimed, the crawler leaves it alone and a second claim conflicts.
    const again = (await (await ingest([crawled({ description: "Crawler tries to change it again." })])).json()) as any;
    expect(again.rejected[0].reason).toBe("claimed by owner");
    expect((await claim("@alexdev/pdf-tools", alexToken)).status).toBe(409);
  });

  it("refuses a claim from anyone but the repository owner", async () => {
    await ingest([crawled()]);
    const res = await claim("@alexdev/pdf-tools", sarahToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.message).toContain("alexdev");
    expect((await claim("@alexdev/nope", alexToken)).status).toBe(404);
    expect((await claim("pdf-summarizer", alexToken)).status).toBe(409); // published, not claimable
  });

  it("requires sign-in to claim", async () => {
    await ingest([crawled()]);
    const res = await app.request("/v1/skills/%40alexdev%2Fpdf-tools/claim", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("lets the scope owner take over an unclaimed listing by publishing", async () => {
    await ingest([crawled()]);
    await db.prepare(
      "INSERT OR IGNORE INTO scopes (scope, owner_id, github_id, created_at) VALUES ('alexdev', 'usr_alexdev', 10101, ?)"
    ).bind(new Date().toISOString()).run();

    const manifest = {
      name: "@alexdev/pdf-tools",
      version: "1.0.0",
      description: "Extract text and tables from PDF files for agents.",
      license: "MIT",
      category: "documents",
      compatibility: ["claude"],
      permissions: { network: false, shell: false, filesystem: "read" }
    };
    const tar = buildTarGz([
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "SKILL.md", content: "---\nname: alexdev--pdf-tools\ndescription: Extract text and tables from PDF files for agents.\n---\n# PDF tools" }
    ]);
    const form = new FormData();
    form.append("file", new Blob([tar], { type: "application/gzip" }), "package.tar.gz");

    const res = await app.request("/v1/skills", { method: "POST", headers: { Authorization: `Bearer ${alexToken}` }, body: form }, env);
    const text = await res.clone().text();
    expect(res.status, text).toBe(201);
    const row = await db.prepare("SELECT owner_id, source, claim_status FROM skills WHERE name = '@alexdev/pdf-tools'").first<any>();
    expect(row).toEqual({ owner_id: "usr_alexdev", source: "published", claim_status: "claimed" });
  });
});
