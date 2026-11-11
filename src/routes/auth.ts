import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { computeSha256 } from "../utils/crypto";
import type { Env } from "../types";

export const authRouter = new Hono<{ Bindings: Env }>();

function generateRandomHex(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 1. GET /v1/auth/github - Initiate OAuth login
authRouter.get("/github", (c) => {
  const clientId = c.env?.GITHUB_CLIENT_ID;
  if (!clientId) {
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "GitHub OAuth client ID is not configured."
        }
      },
      500
    );
  }

  const state = generateRandomHex(16);

  setCookie(c, "oauth_state", state, {
    path: "/",
    httpOnly: true,
    secure: c.env?.ENVIRONMENT !== "development",
    sameSite: "Lax",
    maxAge: 600 // 10 minutes
  });

  const scope = encodeURIComponent("read:user");
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}&scope=${scope}`;

  return c.redirect(githubAuthUrl);
});

// 2. GET /v1/auth/github/callback - OAuth Callback
authRouter.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, "oauth_state");

  if (!code || !state || !cookieState || state !== cookieState) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid or expired OAuth state parameter."
        }
      },
      400
    );
  }

  deleteCookie(c, "oauth_state");

  const clientId = c.env?.GITHUB_CLIENT_ID;
  const clientSecret = c.env?.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "GitHub OAuth credentials are not configured on server."
        }
      },
      500
    );
  }

  // Exchange code for GitHub access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code
    })
  });

  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Failed to exchange GitHub authorization code."
        }
      },
      401
    );
  }

  // Fetch user profile from GitHub
  const profileRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "skillapt-registry"
    }
  });

  if (!profileRes.ok) {
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to retrieve user profile from GitHub."
        }
      },
      500
    );
  }

  const profile = (await profileRes.json()) as {
    id: number;
    login: string;
    name?: string;
    avatar_url: string;
    email?: string;
  };

  // Upsert user in database
  const now = new Date().toISOString();
  let userId = `usr_${profile.id}`;

  const existingUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE github_id = ?"
  ).bind(profile.id).first<{ id: string }>();

  // Check if another user previously held this handle (handle collision / rename)
  const conflictingUser = await c.env.DB.prepare(
    "SELECT id, github_id FROM users WHERE handle = ? AND github_id != ?"
  ).bind(profile.login, profile.id).first<{ id: string; github_id: number }>();

  if (conflictingUser) {
    // Safely update the old holder's handle to avoid UNIQUE(handle) 500 error
    await c.env.DB.prepare(
      "UPDATE users SET handle = ? WHERE id = ?"
    ).bind(`${profile.login}_${conflictingUser.github_id}`, conflictingUser.id).run();
  }

  if (existingUser) {
    userId = existingUser.id;
    await c.env.DB.prepare(`
      UPDATE users 
      SET handle = ?, name = ?, email = NULL, avatar_url = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      profile.login,
      profile.name || profile.login,
      profile.avatar_url,
      now,
      userId
    ).run();
  } else {
    await c.env.DB.prepare(`
      INSERT INTO users (id, github_id, handle, name, email, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).bind(
      userId,
      profile.id,
      profile.login,
      profile.name || profile.login,
      profile.avatar_url,
      now,
      now
    ).run();
  }

  // Claim scope ownership for user's lowercased GitHub handle
  const handleLower = profile.login.toLowerCase();
  const existingScope = await c.env.DB.prepare(
    "SELECT scope, github_id FROM scopes WHERE scope = ?"
  ).bind(handleLower).first<{ scope: string; github_id: number }>();

  if (!existingScope) {
    await c.env.DB.prepare(
      "INSERT INTO scopes (scope, owner_id, github_id, created_at) VALUES (?, ?, ?, ?)"
    ).bind(handleLower, userId, profile.id, now).run();
  }

  // Rotate session: revoke any existing session cookie
  const oldRawSession = getCookie(c, "skillapt_session");
  if (oldRawSession) {
    const oldSessionHash = await computeSha256(new TextEncoder().encode(oldRawSession));
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(oldSessionHash).run();
    deleteCookie(c, "skillapt_session", { path: "/" });
  }

  // Create new session stored as sha256(sessionId)
  const rawSessionId = `ses_${generateRandomHex(24)}`;
  const sessionHash = await computeSha256(new TextEncoder().encode(rawSessionId));
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  await c.env.DB.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(sessionHash, userId, expiresAt, now).run();

  setCookie(c, "skillapt_session", rawSessionId, {
    path: "/",
    httpOnly: true,
    secure: c.env?.ENVIRONMENT !== "development",
    sameSite: "Lax",
    maxAge: 30 * 24 * 60 * 60 // 30 days
  });

  return c.redirect("/dashboard");
});

// 3. POST /v1/auth/logout - Terminate session
authRouter.post("/logout", async (c) => {
  const rawSessionId = getCookie(c, "skillapt_session");
  if (rawSessionId) {
    const sessionHash = await computeSha256(new TextEncoder().encode(rawSessionId));
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionHash).run();
    deleteCookie(c, "skillapt_session", { path: "/" });
  }

  return c.json({
    message: "Successfully logged out."
  });
});
