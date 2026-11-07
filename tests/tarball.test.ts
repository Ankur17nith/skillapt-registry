import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { computeSha256 } from "../src/utils/crypto";
import type { Env } from "../src/types";

describe("Tarball Storage, Download, and SHA-256 Checksums", () => {
  let mockDb: MockD1Database;
  let mockStorage: MockR2Bucket;
  let env: Env;

  const mockTarballContent = new TextEncoder().encode("MOCK_TARBALL_BYTES_FOR_TESTING");

  beforeEach(async () => {
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();
    mockStorage = new MockR2Bucket();

    // Populate R2 with a mock tarball for pdf-summarizer@1.2.0
    await mockStorage.put("skills/pdf-summarizer/1.2.0.tgz", mockTarballContent);

    env = {
      DB: mockDb.asD1(),
      STORAGE: mockStorage.asR2()
    };
  });

  it("calculates accurate SHA-256 hash matching Web Crypto", async () => {
    const data = new TextEncoder().encode("hello world");
    const hash = await computeSha256(data);
    // sha256 of 'hello world'
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("downloads existing tarball with correct headers and increments download count", async () => {
    const beforeDownloads = await mockDb.prepare("SELECT downloads FROM skills WHERE name = ?")
      .bind("pdf-summarizer")
      .first<number>("downloads") ?? 0;

    const res = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.tgz", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    expect(res.headers.get("Content-Disposition")).toContain("pdf-summarizer-1.2.0.tgz");
    expect(res.headers.get("ETag")).toBe('"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"');
    expect(res.headers.get("Cache-Control")).toContain("immutable");

    const bytes = await res.arrayBuffer();
    expect(new Uint8Array(bytes)).toEqual(mockTarballContent);

    const afterDownloads = await mockDb.prepare("SELECT downloads FROM skills WHERE name = ?")
      .bind("pdf-summarizer")
      .first<number>("downloads") ?? 0;

    expect(afterDownloads).toBe(beforeDownloads + 1);
  });

  it("returns 404 if package version is not found in database", async () => {
    const res = await app.request("/v1/skills/pdf-summarizer/-/9.9.9.tgz", {}, env);
    expect(res.status).toBe(404);

    const body = await res.json() as any;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 if tarball object is missing from R2", async () => {
    // Version 1.1.0 is in D1 seed, but we did not put it in mockStorage
    const res = await app.request("/v1/skills/pdf-summarizer/-/1.1.0.tgz", {}, env);
    expect(res.status).toBe(404);

    const body = await res.json() as any;
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("missing from storage");
  });

  it("returns 400 if download path does not end with .tgz", async () => {
    const res = await app.request("/v1/skills/pdf-summarizer/-/1.2.0.zip", {}, env);
    expect(res.status).toBe(400);

    const body = await res.json() as any;
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});
