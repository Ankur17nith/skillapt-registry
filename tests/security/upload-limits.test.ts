import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../../src/index";
import { MockD1Database } from "../helpers/mock-d1";
import { MockR2Bucket } from "../helpers/mock-r2";
import { buildTarGz } from "../helpers/tar-builder";
import { InMemoryRateLimiter } from "../../src/rate-limiter/do";
import type { Env } from "../../src/types";

const token = "apt_live_testtoken1234567890abcdef";

describe("Security: upload size limits and search parameter escaping", () => {
  let env: Env;

  beforeEach(() => {
    const db = new MockD1Database();
    db.applyMigrations();
    db.applySeed();
    env = {
      DB: db.asD1(),
      STORAGE: new MockR2Bucket().asR2(),
      ENVIRONMENT: "test",
      RATE_LIMITER: new InMemoryRateLimiter()
    };
  });

  function chunkedStream(totalBytes: number): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(256 * 1024).fill(0x41);
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.length;
      }
    });
  }

  it("rejects an oversized multipart upload without Content-Length with 413", async () => {
    const boundary = "----skillaptboundary";
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.tgz"\r\nContent-Type: application/gzip\r\n\r\n`
    );
    const body = chunkedStream(8 * 1024 * 1024);
    const reader = body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      }
    });

    const res = await app.request(
      "/v1/skills",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`
        },
        body: stream,
        // @ts-expect-error duplex is required by undici for streaming bodies
        duplex: "half"
      },
      env
    );
    expect(res.status).toBe(413);
  });

  it("still accepts a normal multipart publish", async () => {
    const tarGz = buildTarGz([
      {
        path: "skill.json",
        content: JSON.stringify({
          name: "multipart-ok",
          version: "1.0.0",
          description: "A perfectly ordinary multipart upload test.",
          license: "MIT",
          category: "devtools",
          compatibility: ["claude"],
          permissions: { network: false, shell: false, filesystem: "none" }
        })
      },
      {
        path: "SKILL.md",
        content: "---\nname: multipart-ok\ndescription: A perfectly ordinary multipart upload test.\n---\n# Hi\n"
      }
    ]);
    const form = new FormData();
    form.set("file", new Blob([tarGz], { type: "application/gzip" }), "skill.tgz");
    const res = await app.request(
      "/v1/skills",
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form },
      env
    );
    expect(res.status).toBe(201);
  });

  it("treats LIKE wildcards in the compat filter literally", async () => {
    const all = await app.request("/v1/skills", {}, env);
    const total = ((await all.json()) as any).pagination.total;
    expect(total).toBeGreaterThan(0);

    for (const compat of ["%", "_", "%%"]) {
      const res = await app.request(`/v1/skills?compat=${encodeURIComponent(compat)}`, {}, env);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).pagination.total).toBe(0);
    }
  });
});
