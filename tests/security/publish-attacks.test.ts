import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../../src/index";
import { MockD1Database } from "../helpers/mock-d1";
import { MockR2Bucket } from "../helpers/mock-r2";
import { buildTarGz, createPaxEntry } from "../helpers/tar-builder";
import type { Env } from "../../src/types";

describe("Security: Publish Attack Vectors and Invariants", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  const alexToken = "apt_live_testtoken1234567890abcdef";
  const sarahToken = "apt_live_sarahtoken1234567890abcdef";

  beforeEach(async () => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    // Register Sarah's token and user
    // usr_sarahai (github_id: 2002, handle: sarahai)
    await mockDb.prepare(
      "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind(
      "tok_sarah",
      "usr_sarahai",
      "sarah-cli",
      "apt_live_sara",
      "f140f102f06afe2a460be2360d59217ea0653fa7fbc90dd7eb55baf2de5111eb",
      new Date().toISOString()
    ).run();

    // Claim alexdev scope for alexdev (github_id 1001)
    await mockDb.prepare(
      "INSERT INTO scopes (scope, owner_id, github_id, created_at) VALUES (?, ?, ?, ?)"
    ).bind("alexdev", "usr_alexdev", 1001, new Date().toISOString()).run();

    // Claim sarahai scope for sarahai (github_id 2002)
    await mockDb.prepare(
      "INSERT INTO scopes (scope, owner_id, github_id, created_at) VALUES (?, ?, ?, ?)"
    ).bind("sarahai", "usr_sarahai", 2002, new Date().toISOString()).run();

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2(),
      ENVIRONMENT: "test"
    };
  });

  function makePayload(manifest: Record<string, unknown>, skillMd: string, extraFiles: { path: string; content: string | Uint8Array; typeFlag?: string }[] = []) {
    return buildTarGz([
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "SKILL.md", content: skillMd },
      ...extraFiles
    ]);
  }

  const baseValidManifest = {
    name: "security-tool",
    version: "1.0.0",
    description: "A legitimate security testing tool for AI agent workflows.",
    license: "Apache-2.0",
    category: "devtools",
    compatibility: ["claude", "cursor"],
    dependencies: {},
    permissions: {
      network: false,
      shell: false,
      filesystem: "none"
    }
  };

  const baseValidSkillMd = `---
name: security-tool
description: A legitimate security testing tool for AI agent workflows.
---
# Security Tool
Documentation content.`;

  describe("1. Scope Ownership Attacks", () => {
    it("rejects user sarahai publishing @alexdev/pdf-tools with 403 Forbidden", async () => {
      const manifest = {
        ...baseValidManifest,
        name: "@alexdev/pdf-tools"
      };
      const skillMd = `---
name: pdf-tools
description: Hijacked package
---
# Content`;
      const tarGz = makePayload(manifest, skillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sarahToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("rejects user sarahai publishing @anthropic/helper (unclaimed/other scope) with 403 Forbidden", async () => {
      const manifest = {
        ...baseValidManifest,
        name: "@anthropic/helper"
      };
      const skillMd = `---
name: helper
description: Impersonating anthropic
---
# Content`;
      const tarGz = makePayload(manifest, skillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sarahToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error.code).toBe("FORBIDDEN");
    });
  });

  describe("2. Reserved Names Attacks", () => {
    it("rejects publishing unscoped reserved name 'claude' with 400", async () => {
      const manifest = {
        ...baseValidManifest,
        name: "claude"
      };
      const skillMd = `---
name: claude
description: Impersonating Claude core
---
# Claude`;
      const tarGz = makePayload(manifest, skillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.code).toBe("INVALID_PACKAGE");
    });

    it("rejects publishing unscoped reserved name 'admin' with 400", async () => {
      const manifest = {
        ...baseValidManifest,
        name: "admin"
      };
      const skillMd = `---
name: admin
description: Impersonating admin
---
# Admin`;
      const tarGz = makePayload(manifest, skillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.code).toBe("INVALID_PACKAGE");
    });

    it("rejects publishing scoped package using reserved package name with 400", async () => {
      const manifest = {
        ...baseValidManifest,
        name: "@alexdev/admin"
      };
      const skillMd = `---
name: admin
description: Tool under reserved name
---
# Tool`;
      const tarGz = makePayload(manifest, skillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
    });
  });

  describe("3. Canonical Versions Attacks", () => {
    const nonCanonicalVersions = ["v1.0.0", " 1.0.0", "1.0.0+evil", "1.0", "01.0.0"];

    for (const v of nonCanonicalVersions) {
      it(`rejects non-canonical version '${v}' with 400`, async () => {
        const manifest = {
          ...baseValidManifest,
          version: v
        };
        const tarGz = makePayload(manifest, baseValidSkillMd);

        const res = await app.request("/v1/skills", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/gzip"
          },
          body: tarGz
        }, env);

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe("INVALID_PACKAGE");
      });
    }
  });

  describe("4. Manifest Fields Validation & Attacks", () => {
    it("rejects invalid dependency key names with 400", async () => {
      const manifest = {
        ...baseValidManifest,
        dependencies: {
          "INVALID_UPPERCASE_DEP": "^1.0.0"
        }
      };
      const tarGz = makePayload(manifest, baseValidSkillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
    });

    it("rejects self-dependency with 400", async () => {
      const manifest = {
        ...baseValidManifest,
        name: "self-loop-skill",
        dependencies: {
          "self-loop-skill": "^1.0.0"
        }
      };
      const skillMd = `---
name: self-loop-skill
description: Self referencing dependency attack
---
# Self Loop`;
      const tarGz = makePayload(manifest, skillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
    });

    it("rejects non-existent dependency with 400 INVALID_DEPENDENCY", async () => {
      const manifest = {
        ...baseValidManifest,
        dependencies: {
          "ghost-package-that-does-not-exist": "^1.0.0"
        }
      };
      const tarGz = makePayload(manifest, baseValidSkillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.code).toBe("INVALID_DEPENDENCY");
    });

    it("rejects dependency cycles with 400 INVALID_DEPENDENCY", async () => {
      // Seed skill A and skill B where B depends on A
      await mockDb.prepare(`
        INSERT INTO skills (name, owner_id, description, license, category, keywords, compatibility, downloads, verified, created_at, updated_at)
        VALUES ('cycle-pkg-b', 'usr_alexdev', 'Cycle package B', 'MIT', 'coding', '[]', '["claude"]', 0, 0, datetime('now'), datetime('now'))
      `).run();
      await mockDb.prepare(`
        INSERT INTO skill_versions (id, skill_name, version, sha256, size, tarball_path, yanked, permissions, published_by, published_at)
        VALUES ('ver_b', 'cycle-pkg-b', '1.0.0', 'hash', 100, 'path', 0, '{}', 'usr_alexdev', datetime('now'))
      `).run();
      await mockDb.prepare(`
        INSERT INTO dependencies (id, skill_name, version, dep_name, dep_version_range)
        VALUES ('dep_b_a', 'cycle-pkg-b', '1.0.0', 'cycle-pkg-a', '^1.0.0')
      `).run();

      // Now attempt to publish cycle-pkg-a that depends on cycle-pkg-b
      const manifest = {
        ...baseValidManifest,
        name: "cycle-pkg-a",
        dependencies: {
          "cycle-pkg-b": "^1.0.0"
        }
      };
      const skillMd = `---
name: cycle-pkg-a
description: Cycle attacker
---
# Cycle`;
      const tarGz = makePayload(manifest, skillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.code).toBe("INVALID_DEPENDENCY");
      expect(data.error.message).toContain("cycle");
    });

    it("rejects dependency chains with depth > 10 with 400 INVALID_DEPENDENCY", async () => {
      // Create chain depth 11: chain-1 -> chain-2 -> ... -> chain-11
      for (let i = 1; i <= 11; i++) {
        await mockDb.prepare(`
          INSERT INTO skills (name, owner_id, description, license, category, keywords, compatibility, downloads, verified, created_at, updated_at)
          VALUES ('chain-pkg-${i}', 'usr_alexdev', 'Chain pkg', 'MIT', 'coding', '[]', '["claude"]', 0, 0, datetime('now'), datetime('now'))
        `).run();
        await mockDb.prepare(`
          INSERT INTO skill_versions (id, skill_name, version, sha256, size, tarball_path, yanked, permissions, published_by, published_at)
          VALUES ('ver_c_${i}', 'chain-pkg-${i}', '1.0.0', 'hash', 100, 'path', 0, '{}', 'usr_alexdev', datetime('now'))
        `).run();
        if (i < 11) {
          await mockDb.prepare(`
            INSERT INTO dependencies (id, skill_name, version, dep_name, dep_version_range)
            VALUES ('dep_c_${i}', 'chain-pkg-${i}', '1.0.0', 'chain-pkg-${i + 1}', '^1.0.0')
          `).run();
        }
      }

      // Root depends on chain-pkg-1, which goes down 11 levels
      const manifest = {
        ...baseValidManifest,
        dependencies: {
          "chain-pkg-1": "^1.0.0"
        }
      };
      const tarGz = makePayload(manifest, baseValidSkillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.code).toBe("INVALID_DEPENDENCY");
      expect(data.error.message).toContain("depth");
    });

    it("rejects invalid compatibility targets with 400", async () => {
      const manifest = {
        ...baseValidManifest,
        compatibility: ["windows", "unsupported-engine"]
      };
      const tarGz = makePayload(manifest, baseValidSkillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
    });

    it("rejects non-https repository URLs with 400", async () => {
      const invalidRepos = [
        "http://insecure.example.com/repo",
        "git@github.com:user/repo.git",
        "javascript:alert(1)"
      ];

      for (const repo of invalidRepos) {
        const manifest = {
          ...baseValidManifest,
          repository: repo
        };
        const tarGz = makePayload(manifest, baseValidSkillMd);

        const res = await app.request("/v1/skills", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/gzip"
          },
          body: tarGz
        }, env);

        expect(res.status).toBe(400);
      }
    });

    it("rejects license exceeding 50 chars or containing forbidden characters with 400", async () => {
      const badLicenses = [
        "A".repeat(51),
        "<script>alert(1)</script>",
        "MIT; rm -rf /"
      ];

      for (const lic of badLicenses) {
        const manifest = {
          ...baseValidManifest,
          license: lic
        };
        const tarGz = makePayload(manifest, baseValidSkillMd);

        const res = await app.request("/v1/skills", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alexToken}`,
            "Content-Type": "application/gzip"
          },
          body: tarGz
        }, env);

        expect(res.status).toBe(400);
      }
    });
  });

  describe("5. SKILL.md Verification Attacks", () => {
    it("rejects oversized SKILL.md (> 256 KB) with 400", async () => {
      const hugeContent = `---\nname: security-tool\ndescription: Oversized\n---\n` + "X".repeat(260 * 1024);
      const tarGz = makePayload(baseValidManifest, hugeContent);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("256 KB");
    });

    it("rejects SKILL.md without YAML frontmatter with 400", async () => {
      const noFrontmatter = "# Security Tool\nJust plain markdown without frontmatter.";
      const tarGz = makePayload(baseValidManifest, noFrontmatter);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("frontmatter");
    });

    it("rejects SKILL.md with invalid YAML frontmatter with 400", async () => {
      const invalidYaml = `---\nname: [unclosed list\n---\n# Content`;
      const tarGz = makePayload(baseValidManifest, invalidYaml);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
    });

    it("rejects SKILL.md with name mismatching unscoped package name with 400", async () => {
      const mismatchedSkillMd = `---
name: completely-different-name
description: Name does not match manifest
---
# Mismatch`;
      const tarGz = makePayload(baseValidManifest, mismatchedSkillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("must match unscoped package name");
    });

    it("rejects SKILL.md with empty frontmatter description with 400", async () => {
      const emptyDescSkillMd = `---
name: security-tool
description: "   "
---
# Content`;
      const tarGz = makePayload(baseValidManifest, emptyDescSkillMd);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("description");
    });
  });

  describe("6. Tar Parser Exploits & Magic Byte Detection", () => {
    it("rejects ELF binary disguised inside run.py with 400", async () => {
      const elfBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: "run.py", content: elfBytes }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("ELF");
    });

    it("rejects PE 'MZ' executable disguised inside a.txt with 400", async () => {
      const mzBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: "notes.txt", content: mzBytes }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("PE executable");
    });

    it("rejects WebAssembly binary with \\0asm magic bytes with 400", async () => {
      const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: "module.json", content: wasmBytes }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("WebAssembly");
    });

    it("rejects Mach-O universal binary / Java class with 0xCAFEBABE magic bytes with 400", async () => {
      const javaBytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: "template.mustache", content: javaBytes }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
    });

    it("rejects PAX record path=payload.exe preceding a benign ok.md with 400", async () => {
      const paxHeader = createPaxEntry({ path: "payload.exe" });
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        paxHeader,
        { path: "ok.md", content: "Harmless content" }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("payload.exe");
    });

    it("rejects hidden directory '.claude/settings.json' with 400", async () => {
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: ".claude/settings.json", content: "{}" }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("Hidden path segment");
    });

    it("rejects duplicate paths (case-insensitive and NFC) with 400", async () => {
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: "scripts/run.py", content: "print(1)" },
        { path: "scripts/RUN.PY", content: "print(2)" }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("Duplicate path");
    });

    it("rejects manifest confusion with secondary skill.json in subdir with 400", async () => {
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: "subdir/skill.json", content: "{}" }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("Manifest confusion");
    });

    it("rejects path with backslashes with 400", async () => {
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: "scripts\\run.py", content: "print(1)" }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("backslashes");
    });

    it("rejects path with leading/trailing spaces with 400", async () => {
      const tarGz = makePayload(baseValidManifest, baseValidSkillMd, [
        { path: " scripts/run.py", content: "print(1)" }
      ]);

      const res = await app.request("/v1/skills", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alexToken}`,
          "Content-Type": "application/gzip"
        },
        body: tarGz
      }, env);

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.message).toContain("leading or trailing spaces");
    });
  });
});
