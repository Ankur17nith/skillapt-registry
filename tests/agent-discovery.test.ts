import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import type { Env } from "../src/types";

describe("Agent-friendly discovery", () => {
  let env: Env;

  beforeEach(() => {
    const db = new MockD1Database();
    db.applyMigrations();
    db.applySeed();
    env = { DB: db.asD1(), STORAGE: {} as any };
  });

  it("lists categories with descriptions and counts (json and text)", async () => {
    const res = await app.request("/v1/categories", {}, env);
    const body = (await res.json()) as any;
    expect(body.categories.length).toBeGreaterThanOrEqual(15);
    expect(body.categories.every((c: any) => c.description && typeof c.count === "number")).toBe(true);
    expect(body.categories.reduce((n: number, c: any) => n + c.count, 0)).toBe(20);

    const text = await (await app.request("/v1/categories?format=text", {}, env)).text();
    expect(text).toContain("skillapt search --category");
  });

  it("accepts the new categories as a filter", async () => {
    const res = await app.request("/v1/skills?category=security", {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).skills).toEqual([]);
  });

  it("returns ranked plain text with an install line", async () => {
    const res = await app.request("/v1/skills?q=changelog%20release&format=text", {}, env);
    const text = await res.text();
    expect(text).toContain("changelog-builder");
    expect(text).toContain("install: npx skillapt install changelog-builder");
  });

  it("returns a helpful text message when nothing matches", async () => {
    const text = await (await app.request("/v1/skills?q=zzzqqq&format=text", {}, env)).text();
    expect(text).toContain("No skills found");
  });

  it("serves a skill as markdown via format=md and Accept", async () => {
    const a = await app.request("/v1/skills/changelog-builder?format=md", {}, env);
    expect(a.headers.get("content-type")).toContain("text/markdown");
    const md = await a.text();
    expect(md).toContain("# changelog-builder");
    expect(md).toContain("npx skillapt install changelog-builder");

    const b = await app.request("/v1/skills/changelog-builder", { headers: { Accept: "text/markdown" } }, env);
    expect(b.headers.get("content-type")).toContain("text/markdown");
  });

  it("includes source and ownership fields in JSON", async () => {
    const body = (await (await app.request("/v1/skills/changelog-builder", {}, env)).json()) as any;
    expect(body.source).toBe("published");
    expect(body.claimStatus).toBe("owned");
    expect(body.installCommand).toBe("npx skillapt install changelog-builder");
  });

  it("serves llms.txt at / and /v1", async () => {
    for (const path of ["/llms.txt", "/v1/llms.txt"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("format=text");
      expect(text).toContain("npx skillapt install");
    }
  });
});
