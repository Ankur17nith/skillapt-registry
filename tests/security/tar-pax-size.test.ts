import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { inspectAndValidateTarball } from "../../src/validation/tar";
import { createTarBlock, createPaxEntry } from "../helpers/tar-builder";

const encoder = new TextEncoder();

function padded(content: Uint8Array): Uint8Array[] {
  if (content.length === 0) return [];
  const rem = content.length % 512;
  return rem === 0 ? [content] : [content, new Uint8Array(512 - rem)];
}

function assemble(chunks: Uint8Array[]): Uint8Array {
  const all = [...chunks, new Uint8Array(1024)];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of all) {
    out.set(c, off);
    off += c.length;
  }
  return zlib.gzipSync(out);
}

function fileChunks(path: string, content: string): Uint8Array[] {
  const bytes = encoder.encode(content);
  return [createTarBlock({ path, content: bytes }), ...padded(bytes)];
}

const manifest = JSON.stringify({
  name: "pax-size-test",
  version: "1.0.0",
  description: "Regression test fixture for PAX size handling.",
  license: "MIT",
  category: "devtools",
  compatibility: ["claude"],
  permissions: { network: false, shell: false, filesystem: "none" }
});
const skillMd = `---\nname: pax-size-test\ndescription: Regression test fixture for PAX size handling.\n---\n# Doc\n`;

function baseChunks(): Uint8Array[] {
  return [...fileChunks("skill.json", manifest), ...fileChunks("SKILL.md", skillMd)];
}

describe("Security: PAX size override must not desynchronise the validator from extractors", () => {
  it("rejects a symlink entry smuggled inside the data region of a PAX size=0 decoy file", async () => {
    // The decoy header declares 1024 bytes, but a PAX record overrides its size to 0.
    // A conforming extractor therefore treats the next 512-byte block as a *header*.
    const decoyHeader = createTarBlock({ path: "decoy.txt", content: new Uint8Array(1024) });
    const smuggled = createTarBlock({
      path: "evil",
      content: "",
      typeFlag: "2",
      linkName: "/etc/passwd"
    });
    const pax = createPaxEntry({ size: "0" });
    const paxBytes = encoder.encode(pax.content as string);

    const tarGz = assemble([
      ...baseChunks(),
      createTarBlock({ ...pax, content: paxBytes }),
      ...padded(paxBytes),
      decoyHeader,
      smuggled,
      new Uint8Array(512) // remainder of the 1024-byte declared data region
    ]);

    const res = await inspectAndValidateTarball(tarGz);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/symlink|hardlink/i);
  });

  it("rejects a malformed PAX size record", async () => {
    for (const bad of ["abc", "-5", "1e3", "12.5", ""]) {
      const pax = createPaxEntry({ size: bad });
      const paxBytes = encoder.encode(pax.content as string);
      const tarGz = assemble([
        ...baseChunks(),
        createTarBlock({ ...pax, content: paxBytes }),
        ...padded(paxBytes),
        ...fileChunks("extra.txt", "hello")
      ]);
      const res = await inspectAndValidateTarball(tarGz);
      expect(res.success, `size=${JSON.stringify(bad)}`).toBe(false);
      expect(res.error).toMatch(/PAX size/i);
    }
  });

  it("rejects an entry whose declared size runs past the end of the archive", async () => {
    const header = createTarBlock({ path: "big.txt", content: new Uint8Array(4096) });
    const tarGz = assemble([...baseChunks(), header, new Uint8Array(512)]);
    const res = await inspectAndValidateTarball(tarGz);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/truncated|exceeds the end/i);
  });

  it("still accepts a legitimate PAX size/path override", async () => {
    const content = "hello world";
    const pax = createPaxEntry({ path: "notes.txt", size: String(content.length) });
    const paxBytes = encoder.encode(pax.content as string);
    const tarGz = assemble([
      ...baseChunks(),
      createTarBlock({ ...pax, content: paxBytes }),
      ...padded(paxBytes),
      createTarBlock({ path: "placeholder", content }),
      ...padded(encoder.encode(content))
    ]);
    const res = await inspectAndValidateTarball(tarGz);
    expect(res.success, res.error).toBe(true);
  });
});
