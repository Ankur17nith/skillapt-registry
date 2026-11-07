import { describe, it, expect, beforeEach } from "vitest";
import { MockD1Database } from "./helpers/mock-d1";

describe("Database Schema and Seed Migrations", () => {
  let d1: MockD1Database;

  beforeEach(() => {
    d1 = new MockD1Database();
    d1.applyMigrations();
    d1.applySeed();
  });

  it("seeds 20 realistic agent skills with proper categories and compatibility", async () => {
    const res = await d1.prepare("SELECT COUNT(*) as count FROM skills").first<{ count: number }>("count");
    expect(res).toBe(20);

    const skills = await d1.prepare("SELECT name, category, downloads, verified FROM skills ORDER BY downloads DESC").all<{
      name: string;
      category: string;
      downloads: number;
      verified: number;
    }>();

    expect(skills.results.length).toBe(20);
    // Highest downloaded skill is git-commit-helper with 5230 downloads
    expect(skills.results[0].name).toBe("git-commit-helper");
    expect(skills.results[0].downloads).toBe(5230);
  });

  it("seeds realistic authors with GitHub metadata", async () => {
    const authors = await d1.prepare("SELECT id, handle, name FROM users ORDER BY handle ASC").all<{
      id: string;
      handle: string;
      name: string;
    }>();
    expect(authors.results.length).toBe(4);
    expect(authors.results.map((a) => a.handle)).toEqual(["alexdev", "marcusk", "priyar", "sarahai"]);
  });

  it("seeds package versions with sha256 and permissions", async () => {
    const versions = await d1.prepare("SELECT skill_name, version, sha256, permissions FROM skill_versions WHERE skill_name = ?")
      .bind("pdf-summarizer")
      .all<{ skill_name: string; version: string; sha256: string; permissions: string }>();

    expect(versions.results.length).toBe(2);
    const parsedPerms = JSON.parse(versions.results[0].permissions);
    expect(parsedPerms).toHaveProperty("filesystem");
    expect(parsedPerms).toHaveProperty("network");
    expect(parsedPerms).toHaveProperty("shell");
  });

  it("seeds dependencies properly linked to skill versions", async () => {
    const deps = await d1.prepare("SELECT dep_name, dep_version_range FROM dependencies WHERE skill_name = ?")
      .bind("pdf-summarizer")
      .all<{ dep_name: string; dep_version_range: string }>();

    expect(deps.results.length).toBe(1);
    expect(deps.results[0].dep_name).toBe("text-cleaner");
    expect(deps.results[0].dep_version_range).toBe("^1.0.0");
  });
});
