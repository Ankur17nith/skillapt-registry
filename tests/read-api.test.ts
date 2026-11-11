import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import type { Env } from "../src/types";

describe("Read API Endpoints (/v1/skills)", () => {
  let mockDb: MockD1Database;
  let env: Env;

  beforeEach(() => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    env = {
      DB: mockDb.asD1(),
      STORAGE: {} as any
    };
  });

  describe("GET /v1/skills (List & Search)", () => {
    it("returns all 20 skills by default sorted by downloads", async () => {
      const res = await app.request("/v1/skills", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.skills).toBeDefined();
      expect(body.skills.length).toBe(20);
      expect(body.pagination.total).toBe(20);
      expect(body.pagination.page).toBe(1);
      expect(body.skills[0].name).toBe("git-commit-helper"); // top downloaded
      expect(body.skills[0].owner.handle).toBe("sarahai");
      expect(body.skills[0].latestVersion).toBe("2.0.0");
    });

    it("filters skills by search query q", async () => {
      const res = await app.request("/v1/skills?q=pdf", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.skills.length).toBe(1);
      expect(body.skills[0].name).toBe("pdf-summarizer");
    });

    it("filters skills by category", async () => {
      const res = await app.request("/v1/skills?category=data", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.skills.length).toBeGreaterThan(0);
      for (const s of body.skills) {
        expect(s.category).toBe("data");
      }
    });

    it("filters skills by runtime compatibility", async () => {
      const res = await app.request("/v1/skills?compat=antigravity", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.skills.length).toBeGreaterThan(0);
      for (const s of body.skills) {
        expect(s.compatibility).toContain("antigravity");
      }
    });

    it("filters skills by verified badge", async () => {
      const res = await app.request("/v1/skills?verified=true", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.skills.length).toBeGreaterThan(0);
      for (const s of body.skills) {
        expect(s.verified).toBe(true);
      }
    });

    it("supports sorting by name and pagination", async () => {
      const res = await app.request("/v1/skills?sort=name&page=1&limit=5", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.skills.length).toBe(5);
      expect(body.pagination.total).toBe(20);
      expect(body.pagination.totalPages).toBe(4);
      expect(body.skills[0].name).toBe("api-mock-server");
    });
  });

  describe("GET /v1/skills/:name (Metadata & Versions)", () => {
    it("returns complete skill metadata with all versions and readme", async () => {
      const res = await app.request("/v1/skills/pdf-summarizer", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.name).toBe("pdf-summarizer");
      expect(body.latestVersion).toBe("1.2.0");
      expect(body.owner.handle).toBe("alexdev");
      expect(body.versions["1.2.0"]).toBeDefined();
      expect(body.versions["1.2.0"].dependencies["text-cleaner"]).toBe("^1.0.0");
      expect(body.versions["1.2.0"].permissions.filesystem).toBe("read");
      expect(body.versions["1.1.0"]).toBeDefined();
      expect(body.readme).toContain("# PDF Summarizer");
    });

    it("returns 404 for nonexistent skill", async () => {
      const res = await app.request("/v1/skills/does-not-exist", {}, env);
      expect(res.status).toBe(404);

      const body = await res.json() as any;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("GET /v1/skills/:name/:version (Specific Version Metadata)", () => {
    it("returns exact version details and integrity hash", async () => {
      const res = await app.request("/v1/skills/pdf-summarizer/1.2.0", {}, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.name).toBe("pdf-summarizer");
      expect(body.version).toBe("1.2.0");
      expect(body.sha256).toBe("0f6fca4a57687bd3e4fb4b54d4c25eff32239a5a869595b2189bb5df3ec664a1");
      expect(body.dependencies["text-cleaner"]).toBe("^1.0.0");
      expect(body.permissions.filesystem).toBe("read");
      expect(body.yanked).toBe(false);
    });

    it("returns 404 for nonexistent version", async () => {
      const res = await app.request("/v1/skills/pdf-summarizer/9.9.9", {}, env);
      expect(res.status).toBe(404);

      const body = await res.json() as any;
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });
});
