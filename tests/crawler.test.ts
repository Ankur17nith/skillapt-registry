import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM helper without types
import { classify, parseFrontmatter, toSkillName, isOptedOut, toIngestEntry } from "../scripts/lib/crawl.mjs";

const repo = { owner: "AliceDev", name: "skills", url: "https://github.com/AliceDev/skills", license: "MIT", topics: ["pdf"], fork: false, archived: false };
const md = (extra = "") => `---\nname: PDF Tools\ndescription: Extract text and tables from PDF files.\n${extra}---\n# Body that must never be stored`;

describe("crawler helpers", () => {
  it("classifies by what a skill is for", () => {
    expect(classify("Extract tables from PDF files")).toBe("documents");
    expect(classify("Audit dependencies for vulnerabilities")).toBe("security");
    expect(classify("Write SQL queries for Postgres")).toBe("database");
    expect(classify("Generate conventional git commit messages")).toBe("devtools");
    expect(classify("zzz")).toBe("other");
  });

  it("parses frontmatter and rejects bad YAML", () => {
    expect(parseFrontmatter("---\nname: x\n---\nbody")).toEqual({ name: "x" });
    expect(parseFrontmatter("no frontmatter")).toBeNull();
    expect(parseFrontmatter("---\n: : :\n  - [\n---")).toBeNull();
  });

  it("builds owner-scoped names", () => {
    expect(toSkillName("AliceDev", "PDF Tools", "x")).toBe("@alicedev/pdf-tools");
    expect(toSkillName("AliceDev", "", "my_dir")).toBe("@alicedev/my-dir");
    expect(toSkillName("a", "tool", "x")).toBeNull();
    expect(toSkillName("alice", "", "")).toBeNull();
  });

  it("honours opt-outs", () => {
    expect(isOptedOut({ skillapt: false }, "x")).toBe(true);
    expect(isOptedOut({}, "Bob", ["bob"])).toBe(true);
    expect(isOptedOut({}, "carol", ["bob"])).toBe(false);
  });

  it("produces metadata only, with a source link", () => {
    const { entry } = toIngestEntry({ repo, path: "tools/pdf/SKILL.md", sha: "abc1234", markdown: md() });
    expect(entry.name).toBe("@alicedev/pdf-tools");
    expect(entry.category).toBe("documents");
    expect(entry.sourcePath).toBe("tools/pdf");
    expect(entry.sourceOwner).toBe("AliceDev");
    expect(JSON.stringify(entry)).not.toContain("Body that must never");
  });

  it("skips forks, archived repos, opt-outs and thin descriptions", () => {
    const base = { path: "SKILL.md", sha: "abc1234", markdown: md() };
    expect(toIngestEntry({ ...base, repo: { ...repo, fork: true } }).skip).toBe("fork");
    expect(toIngestEntry({ ...base, repo: { ...repo, archived: true } }).skip).toBe("archived");
    expect(toIngestEntry({ ...base, repo, markdown: md("skillapt: false\n") }).skip).toBe("opted out");
    expect(toIngestEntry({ ...base, repo, markdown: "---\nname: x\ndescription: hi\n---" }).skip).toBe("no description");
  });
});
