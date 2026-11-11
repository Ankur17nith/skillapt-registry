import { describe, it, expect } from "vitest";
import { inspectAndValidateTarball } from "../src/validation/tar";
import { validateManifest } from "../src/validation/manifest";
import { buildTarGz } from "./helpers/tar-builder";

describe("Package Validation & Safe Tarball Inspection", () => {
  const validManifest = {
    name: "pdf-summarizer",
    version: "1.2.0",
    description: "Extracts text from PDF documents and generates structured agent summaries.",
    license: "MIT",
    repository: "https://github.com/agent-skills/pdf-summarizer",
    keywords: ["pdf", "summarizer", "documents"],
    category: "documents",
    compatibility: ["claude", "cursor", "codex"],
    dependencies: {
      "text-cleaner": "^1.0.0"
    },
    permissions: {
      network: false,
      shell: false,
      filesystem: "read"
    }
  };

  const validSkillMd = `---
name: pdf-summarizer
description: Teaches agents how to extract text from PDF files.
---
# PDF Summarizer

Teaches agents how to extract text from PDF files.`;

  describe("Zod Manifest Validation", () => {
    it("accepts a fully compliant skill manifest", () => {
      const res = validateManifest(validManifest);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.name).toBe("pdf-summarizer");
        expect(res.data.version).toBe("1.2.0");
      }
    });

    it("accepts scoped package names", () => {
      const scoped = { ...validManifest, name: "@acme/code-cleaner" };
      const res = validateManifest(scoped);
      expect(res.success).toBe(true);
    });

    it("rejects invalid package names", () => {
      const invalidNames = [
        "PDF-Summarizer", // uppercase
        "pdf summarizer", // space
        "-pdf-summarizer", // leading hyphen
        "pdf-summarizer-", // trailing hyphen
        "ab", // too short (< 3)
        "a".repeat(51), // too long (> 50)
        "@/missing-scope" // invalid scope
      ];

      for (const name of invalidNames) {
        const res = validateManifest({ ...validManifest, name });
        expect(res.success).toBe(false);
      }
    });

    it("rejects non-semver versions", () => {
      const res = validateManifest({ ...validManifest, version: "v1.2" });
      expect(res.success).toBe(false);
    });

    it("rejects missing or invalid permissions", () => {
      const noPerms = { ...validManifest, permissions: undefined };
      expect(validateManifest(noPerms).success).toBe(false);

      const invalidFs = {
        ...validManifest,
        permissions: { network: true, shell: false, filesystem: "root-access" }
      };
      expect(validateManifest(invalidFs).success).toBe(false);
    });

    it("rejects invalid category", () => {
      const res = validateManifest({ ...validManifest, category: "blockchain" });
      expect(res.success).toBe(false);
    });

    it("rejects invalid dependency semver range", () => {
      const res = validateManifest({
        ...validManifest,
        dependencies: { "text-cleaner": "invalid-range@@" }
      });
      expect(res.success).toBe(false);
    });
  });

  describe("Safe Tarball Archive Inspection", () => {
    it("successfully validates a legitimate package tarball", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: validSkillMd },
        { path: "scripts/run.py", content: "print('hello from python')" },
        { path: ".gitignore", content: "node_modules/" }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(true);
      expect(res.manifest?.name).toBe("pdf-summarizer");
      expect(res.readme).toContain("# PDF Summarizer");
      expect(res.fileCount).toBe(4);
    });

    it("successfully validates a package wrapped in root directory folder", async () => {
      const tarGz = buildTarGz([
        { path: "pdf-summarizer/skill.json", content: JSON.stringify(validManifest) },
        { path: "pdf-summarizer/SKILL.md", content: validSkillMd },
        { path: "pdf-summarizer/prompt.md", content: "Summarize this: {{text}}" }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(true);
      expect(res.manifest?.name).toBe("pdf-summarizer");
    });

    it("blocks path traversal attacks (../)", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: validSkillMd },
        { path: "../../etc/shadow", content: "root:x:0:0:root" }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Path traversal detected");
    });

    it("blocks absolute path attacks (/)", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: validSkillMd },
        { path: "/usr/bin/evil", content: "malicious code" }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Absolute paths are strictly forbidden");
    });

    it("blocks symlinks and hardlinks", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: validSkillMd },
        {
          path: "symlink-file",
          content: "",
          typeFlag: "2", // symlink
          linkName: "/etc/passwd"
        }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Symlinks and hardlinks are strictly prohibited");
    });

    it("blocks prohibited binary executables (.exe, .so, .bin)", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: validSkillMd },
        { path: "trojan.exe", content: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("File type '.exe' is not permitted");
    });

    it("blocks nested archives (.zip, .tar, .gz)", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: validSkillMd },
        { path: "nested-payload.zip", content: "PK0304" }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("File type '.zip' is not permitted");
    });

    it("blocks disallowed hidden files like .env", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: validSkillMd },
        { path: ".env", content: "SECRET_KEY=12345" }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Hidden file '.env' is not permitted");
    });

    it("fails when skill.json is missing", async () => {
      const tarGz = buildTarGz([
        { path: "SKILL.md", content: validSkillMd }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("missing required 'skill.json'");
    });

    it("fails when SKILL.md is missing or empty", async () => {
      const tarGz = buildTarGz([
        { path: "skill.json", content: JSON.stringify(validManifest) },
        { path: "SKILL.md", content: "   " }
      ]);

      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success).toBe(false);
      expect(res.error).toContain("missing required 'SKILL.md'");
    });

    it("rejects uploads exceeding compressed limit (> 5 MB)", async () => {
      const oversized = new Uint8Array(5 * 1024 * 1024 + 10);
      const res = await inspectAndValidateTarball(oversized);
      expect(res.success).toBe(false);
      expect(res.error).toContain("exceeds the 5 MB upload limit");
    });
  });
});
