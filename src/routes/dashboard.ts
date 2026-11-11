import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import { computeSha256 } from "../utils/crypto";
import type { Env } from "../types";

export const dashboardRouter = new Hono<{ Bindings: Env }>();

const CSP_HEADER = "default-src 'none'; style-src 'unsafe-inline'; img-src https://avatars.githubusercontent.com data:; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none';";

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateRandomHex(bytesCount = 16): string {
  const bytes = new Uint8Array(bytesCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getCsrfToken(sessionHash: string): Promise<string> {
  return computeSha256(new TextEncoder().encode(`csrf:${sessionHash}`));
}

async function getAuthenticatedUser(c: Context<{ Bindings: Env }>): Promise<{
  userId: string;
  githubId: number;
  handle: string;
  name: string;
  avatarUrl: string;
  sessionHash: string;
} | null> {
  const rawSession = getCookie(c, "skillapt_session");
  if (!rawSession) return null;

  const sessionHash = await computeSha256(new TextEncoder().encode(rawSession));
  const row = await c.env.DB.prepare(`
    SELECT s.id, s.expires_at, u.id as user_id, u.github_id, u.handle, u.name, u.avatar_url
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).bind(sessionHash).first<any>();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    try {
      await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionHash).run();
    } catch {
      // ignore
    }
    return null;
  }

  return {
    userId: row.user_id,
    githubId: row.github_id,
    handle: row.handle,
    name: row.name,
    avatarUrl: row.avatar_url,
    sessionHash
  };
}

dashboardRouter.use("*", async (c, next) => {
  c.header("Content-Security-Policy", CSP_HEADER);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  return next();
});

// GET /dashboard
dashboardRouter.get("/", async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    const unauthenticatedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>skillapt Registry - Sign In</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 32px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    h1 { font-size: 24px; margin-bottom: 8px; color: #38bdf8; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 500; font-size: 14px; }
    .btn:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>skillapt Registry</h1>
    <p>Sign in with your GitHub account to manage personal access tokens and publish AI agent skills.</p>
    <a href="/v1/auth/github" class="btn">Sign in with GitHub</a>
  </div>
</body>
</html>`;
    return c.html(unauthenticatedHtml);
  }

  const csrfToken = await getCsrfToken(user.sessionHash);
  const createdToken = c.req.query("created");
  const errorMessage = c.req.query("error");

  const tokensResult = await c.env.DB.prepare(`
    SELECT id, name, prefix, expires_at, created_at, last_used_at
    FROM api_tokens
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(user.userId).all<any>();

  const tokens = tokensResult.results || [];

  const tokensRowsHtml = tokens.length === 0
    ? `<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 24px;">No API tokens generated yet.</td></tr>`
    : tokens.map((t: any) => `
      <tr>
        <td><strong>${escapeHtml(t.name)}</strong></td>
        <td><code>${escapeHtml(t.prefix)}...</code></td>
        <td>${escapeHtml(new Date(t.created_at).toLocaleDateString())}</td>
        <td>${t.expires_at ? escapeHtml(new Date(t.expires_at).toLocaleDateString()) : "Never"}</td>
        <td>
          <form method="POST" action="/dashboard/tokens/${escapeHtml(t.id)}/revoke" style="margin: 0;">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
            <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Revoke this token?');">Revoke</button>
          </form>
        </td>
      </tr>
    `).join("");

  const createdBannerHtml = createdToken
    ? `<div class="alert alert-success">
        <div style="font-weight: 600; margin-bottom: 4px;">New Token Created</div>
        <div style="margin-bottom: 8px;">Copy your token now. It will not be shown again:</div>
        <div style="background: #0f172a; padding: 8px 12px; border-radius: 4px; font-family: monospace; word-break: break-all; border: 1px solid #334155; font-size: 15px; color: #38bdf8;">${escapeHtml(createdToken)}</div>
      </div>`
    : "";

  const errorBannerHtml = errorMessage
    ? `<div class="alert alert-error">${escapeHtml(errorMessage)}</div>`
    : "";

  const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>skillapt Registry - Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 32px 16px; }
    .container { max-width: 860px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #334155; }
    .user-info { display: flex; align-items: center; gap: 12px; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; border: 1px solid #475569; }
    .user-name { font-weight: 600; font-size: 16px; }
    .user-handle { color: #94a3b8; font-size: 13px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 24px; margin-bottom: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    h2 { font-size: 18px; margin-top: 0; margin-bottom: 16px; color: #38bdf8; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: #cbd5e1; }
    input[type="text"] { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; color: #f8fafc; font-size: 14px; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 500; font-size: 14px; cursor: pointer; }
    .btn:hover { background: #1d4ed8; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-secondary { background: #475569; }
    .btn-secondary:hover { background: #334155; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 10px 12px; border-bottom: 2px solid #334155; color: #94a3b8; font-weight: 500; }
    td { padding: 12px; border-bottom: 1px solid #334155; }
    code { font-family: monospace; background: #0f172a; padding: 2px 6px; border-radius: 4px; border: 1px solid #334155; color: #38bdf8; }
    .alert { padding: 16px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
    .alert-success { background: #064e3b; border: 1px solid #059669; color: #d1fae5; }
    .alert-error { background: #7f1d1d; border: 1px solid #dc2626; color: #fee2e2; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="user-info">
        <img class="avatar" src="${escapeHtml(user.avatarUrl)}" alt="Avatar" />
        <div>
          <div class="user-name">${escapeHtml(user.name)}</div>
          <div class="user-handle">@${escapeHtml(user.handle)}</div>
        </div>
      </div>
      <div>
        <form method="POST" action="/dashboard/logout" style="margin: 0;">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
          <button type="submit" class="btn btn-secondary btn-sm">Log Out</button>
        </form>
      </div>
    </div>

    ${createdBannerHtml}
    ${errorBannerHtml}

    <div class="card">
      <h2>Generate Personal Access Token</h2>
      <p style="color: #94a3b8; font-size: 13px; margin-top: -8px; margin-bottom: 16px;">
        Use personal access tokens to authenticate the <code>skillapt</code> CLI for publishing packages.
      </p>
      <form method="POST" action="/dashboard/tokens">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
        <div class="form-group">
          <label for="token-name">Token Name</label>
          <input type="text" id="token-name" name="name" placeholder="e.g. cli-laptop or ci-deploy" required maxlength="50" />
        </div>
        <button type="submit" class="btn">Generate Token</button>
      </form>
    </div>

    <div class="card">
      <h2>Active Access Tokens</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Created</th>
            <th>Expires</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${tokensRowsHtml}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  return c.html(dashboardHtml);
});

// POST /dashboard/tokens - Create token from dashboard
dashboardRouter.post("/tokens", async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) {
    return c.redirect("/dashboard");
  }

  const body = await c.req.parseBody();
  const csrfToken = (body.csrf_token as string)?.trim();
  const expectedCsrf = await getCsrfToken(user.sessionHash);

  if (!csrfToken || csrfToken !== expectedCsrf) {
    return c.text("CSRF token verification failed.", 403);
  }

  const name = (body.name as string)?.trim();
  if (!name || name.length < 1 || name.length > 50) {
    return c.redirect("/dashboard?error=" + encodeURIComponent("Token name must be between 1 and 50 characters."));
  }

  const now = new Date().toISOString();
  const activeCount = (await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).bind(user.userId, now).first<number>("count")) ?? 0;

  if (activeCount >= 20) {
    return c.redirect("/dashboard?error=" + encodeURIComponent("Maximum limit of 20 active tokens reached. Revoke an existing token first."));
  }

  const randomHex = generateRandomHex(16);
  const rawToken = `apt_live_${randomHex}`;
  const prefix = `apt_live_${randomHex.slice(0, 4)}`;
  const tokenHash = await computeSha256(new TextEncoder().encode(rawToken));
  const tokenId = `tok_${generateRandomHex(8)}`;
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days default

  await c.env.DB.prepare(`
    INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, expires_at, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).bind(tokenId, user.userId, name, prefix, tokenHash, expiresAt, now).run();

  return c.redirect(`/dashboard?created=${encodeURIComponent(rawToken)}`);
});

// POST /dashboard/tokens/:id/revoke - Revoke token from dashboard
dashboardRouter.post("/tokens/:id/revoke", async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) {
    return c.redirect("/dashboard");
  }

  const body = await c.req.parseBody();
  const csrfToken = (body.csrf_token as string)?.trim();
  const expectedCsrf = await getCsrfToken(user.sessionHash);

  if (!csrfToken || csrfToken !== expectedCsrf) {
    return c.text("CSRF token verification failed.", 403);
  }

  const tokenId = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
    .bind(tokenId, user.userId)
    .run();

  return c.redirect("/dashboard");
});

// POST /dashboard/logout - Logout from dashboard
dashboardRouter.post("/logout", async (c) => {
  const user = await getAuthenticatedUser(c);
  if (user) {
    const body = await c.req.parseBody();
    const csrfToken = (body.csrf_token as string)?.trim();
    const expectedCsrf = await getCsrfToken(user.sessionHash);

    if (csrfToken && csrfToken === expectedCsrf) {
      await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(user.sessionHash).run();
      deleteCookie(c, "skillapt_session", { path: "/" });
    }
  }

  return c.redirect("/dashboard");
});
