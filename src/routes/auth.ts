import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
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

  const scope = encodeURIComponent("read:user,user:email");
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

  if (existingUser) {
    userId = existingUser.id;
    await c.env.DB.prepare(`
      UPDATE users 
      SET handle = ?, name = ?, email = ?, avatar_url = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      profile.login,
      profile.name || profile.login,
      profile.email || null,
      profile.avatar_url,
      now,
      userId
    ).run();
  } else {
    await c.env.DB.prepare(`
      INSERT INTO users (id, github_id, handle, name, email, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      profile.id,
      profile.login,
      profile.name || profile.login,
      profile.email || null,
      profile.avatar_url,
      now,
      now
    ).run();
  }

  // Create session
  const sessionId = `ses_${generateRandomHex(24)}`;
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  await c.env.DB.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(sessionId, userId, expiresAt, now).run();

  setCookie(c, "skillapt_session", sessionId, {
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
  const sessionId = getCookie(c, "skillapt_session");
  if (sessionId) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
    deleteCookie(c, "skillapt_session", { path: "/" });
  }

  return c.json({
    message: "Successfully logged out."
  });
});
