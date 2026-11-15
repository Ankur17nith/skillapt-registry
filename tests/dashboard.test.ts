import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { MockD1Database } from "./helpers/mock-d1";
import { MockR2Bucket } from "./helpers/mock-r2";
import { computeSha256 } from "../src/utils/crypto";
import { resetRateLimits } from "../src/middleware/rate-limit";
import type { Env } from "../src/types";

describe("Branch 6: Token Dashboard (/dashboard)", () => {
  let mockDb: MockD1Database;
  let env: Env;
  const rawSession = "ses_dash_test_user";

  beforeEach(async () => {
    resetRateLimits();
    mockDb = new MockD1Database();
    mockDb.applyMigrations();
    mockDb.applySeed();

    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    await mockDb.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).bind(sessionHash, "usr_alexdev", expiresAt, new Date().toISOString()).run();

    env = {
      DB: mockDb.asD1(),
      STORAGE: new MockR2Bucket().asR2(),
      ENVIRONMENT: "test"
    };
  });

  it("renders unauthenticated sign-in page with strict CSP when no session exists", async () => {
    const res = await app.request("/dashboard", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("<script"); // No external scripts

    // Verify strict CSP
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
  });

  it("renders authenticated dashboard with user profile, tokens, and forms", async () => {
    const res = await app.request(
      "/dashboard",
      {
        headers: { Cookie: `skillapt_session=${rawSession}` }
      },
      env
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("@alexdev");
    expect(html).toContain("cli-macbook");
    expect(html).toContain("csrf_token");
    expect(html).not.toContain("<script"); // No external scripts
  });

  it("creates a new token via POST /dashboard/tokens with CSRF protection and redirects with token", async () => {
    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const csrfToken = await computeSha256(new TextEncoder().encode(`csrf:${sessionHash}`));

    // 1. Hostile / invalid CSRF token rejected
    const invalidCsrfRes = await app.request(
      "/dashboard/tokens",
      {
        method: "POST",
        headers: {
          Cookie: `skillapt_session=${rawSession}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          csrf_token: "invalid_csrf_token",
          name: "new-dash-token"
        }).toString()
      },
      env
    );
    expect(invalidCsrfRes.status).toBe(403);

    // 2. Valid CSRF creates token and redirects
    const validRes = await app.request(
      "/dashboard/tokens",
      {
        method: "POST",
        headers: {
          Cookie: `skillapt_session=${rawSession}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          csrf_token: csrfToken,
          name: "new-dash-token"
        }).toString()
      },
      env
    );
    expect(validRes.status).toBe(302);
    const location = validRes.headers.get("Location");
    // The new token must never appear in the URL (history, logs, forged links).
    expect(location).toBe("/dashboard");
    const setCookie = validRes.headers.get("Set-Cookie") || "";
    expect(setCookie).toMatch(/skillapt_flash_token=apt_live_[0-9a-f]{32}/);
    expect(setCookie).toMatch(/HttpOnly/i);

    // The token is shown exactly once, then the flash cookie is cleared.
    const flashValue = /skillapt_flash_token=([^;]+)/.exec(setCookie)![1];
    const shown = await app.request(
      "/dashboard",
      { headers: { Cookie: `skillapt_session=${rawSession}; skillapt_flash_token=${flashValue}` } },
      env
    );
    expect(await shown.text()).toContain(flashValue);
    expect(shown.headers.get("Set-Cookie") || "").toMatch(/skillapt_flash_token=;/);

    // Token exists in database
    const tokenRow = await mockDb.prepare("SELECT * FROM api_tokens WHERE name = 'new-dash-token'").first<any>();
    expect(tokenRow).toBeDefined();
    expect(tokenRow.user_id).toBe("usr_alexdev");
  });

  it("revokes token via POST /dashboard/tokens/:id/revoke with CSRF protection", async () => {
    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const csrfToken = await computeSha256(new TextEncoder().encode(`csrf:${sessionHash}`));

    // Seed a token to revoke
    await mockDb.prepare(
      "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind("tok_to_revoke_dash", "usr_alexdev", "to-revoke", "apt_live_revo", "hash123", new Date().toISOString()).run();

    // Revoke
    const res = await app.request(
      "/dashboard/tokens/tok_to_revoke_dash/revoke",
      {
        method: "POST",
        headers: {
          Cookie: `skillapt_session=${rawSession}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ csrf_token: csrfToken }).toString()
      },
      env
    );
    expect(res.status).toBe(302);

    const row = await mockDb.prepare("SELECT * FROM api_tokens WHERE id = 'tok_to_revoke_dash'").first<any>();
    expect(row).toBeNull();
  });

  it("logs out via POST /dashboard/logout with CSRF protection", async () => {
    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const csrfToken = await computeSha256(new TextEncoder().encode(`csrf:${sessionHash}`));

    const res = await app.request(
      "/dashboard/logout",
      {
        method: "POST",
        headers: {
          Cookie: `skillapt_session=${rawSession}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ csrf_token: csrfToken }).toString()
      },
      env
    );
    expect(res.status).toBe(302);

    const sessionRow = await mockDb.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionHash).first<any>();
    expect(sessionRow).toBeNull();
  });

  it("ignores forged ?created= and ?error= query parameters", async () => {
    const res = await app.request(
      "/dashboard?created=apt_live_forged&error=Your%20account%20is%20locked",
      { headers: { Cookie: `skillapt_session=${rawSession}` } },
      env
    );
    const html = await res.text();
    expect(html).not.toContain("apt_live_forged");
    expect(html).not.toContain("Your account is locked");
    expect(html).not.toContain("New Token Created");
  });

  it("applies the daily token creation budget to the dashboard form", async () => {
    const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
    const csrfToken = await computeSha256(new TextEncoder().encode(`csrf:${sessionHash}`));
    const post = () =>
      app.request(
        "/dashboard/tokens",
        {
          method: "POST",
          headers: {
            Cookie: `skillapt_session=${rawSession}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ csrf_token: csrfToken, name: "burst" }).toString()
        },
        env
      );
    for (let i = 0; i < 10; i++) await post();
    const blocked = await post();
    const cookie = blocked.headers.get("Set-Cookie") || "";
    expect(cookie).toContain("skillapt_flash_error=");
    expect(cookie).not.toContain("skillapt_flash_token=");
    const count = await mockDb
      .prepare("SELECT COUNT(*) as c FROM api_tokens WHERE name = 'burst'")
      .first<{ c: number }>();
    expect(count!.c).toBe(10);
  });
});
