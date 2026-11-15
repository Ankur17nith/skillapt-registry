import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../../src/index";
import { MockD1Database } from "../helpers/mock-d1";
import { MockR2Bucket } from "../helpers/mock-r2";
import { InMemoryRateLimiter } from "../../src/rate-limiter/do";
import { computeSha256 } from "../../src/utils/crypto";
import type { Env } from "../../src/types";

const IP = "203.0.113.7";

async function sha(text: string) {
  return computeSha256(new TextEncoder().encode(text));
}

describe("Security: client IP hashing uses a secret salt", () => {
  let db: MockD1Database;
  let env: Env;

  beforeEach(() => {
    db = new MockD1Database();
    db.applyMigrations();
    db.applySeed();
    env = {
      DB: db.asD1(),
      STORAGE: new MockR2Bucket().asR2(),
      ENVIRONMENT: "production",
      RATE_LIMITER: new InMemoryRateLimiter()
    };
  });

  async function report(e: Env): Promise<string> {
    const res = await app.request(
      "/v1/reports",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": IP },
        body: JSON.stringify({
          skillName: "pdf-summarizer",
          version: "*",
          reason: "spam",
          details: "salt test"
        })
      },
      e
    );
    expect(res.status).toBe(201);
    const row = await db
      .prepare("SELECT reporter_hash FROM reports ORDER BY created_at DESC LIMIT 1")
      .first<{ reporter_hash: string }>();
    return row!.reporter_hash;
  }

  it("uses HASH_SALT (the documented secret name)", async () => {
    expect(await report({ ...env, HASH_SALT: "operator-secret" })).toBe(await sha(IP + "operator-secret"));
  });

  it("still honors the legacy REPORT_SALT name", async () => {
    expect(await report({ ...env, REPORT_SALT: "legacy-secret" })).toBe(await sha(IP + "legacy-secret"));
  });

  it("never falls back to the public default salt when another secret is configured", async () => {
    const hash = await report({ ...env, GITHUB_CLIENT_SECRET: "oauth-secret" });
    expect(hash).not.toBe(await sha(IP + "skillapt-default-salt"));
    expect(hash).not.toBe(await sha(IP));
  });
});
