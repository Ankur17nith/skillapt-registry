import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { computeSha256 } from "../utils/crypto";
import type { Env, UserSession } from "../types";

declare module "hono" {
  interface ContextVariableMap {
    user: UserSession;
    authMethod: "token" | "session";
  }
}

interface UserDbRow {
  id: string;
  github_id: number;
  handle: string;
  name: string;
  email: string | null;
  avatar_url: string;
}

export async function authenticate(c: Context<{ Bindings: Env }>): Promise<UserSession | null> {
  const authHeader = c.req.header("Authorization");

  // 1. Try Bearer token
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const rawToken = authHeader.slice(7).trim();
    if (!rawToken) return null;

    const tokenHash = await computeSha256(new TextEncoder().encode(rawToken));

    const tokenRow = await c.env.DB.prepare(`
      SELECT 
        t.id as token_id, t.user_id,
        u.id, u.github_id, u.handle, u.name, u.email, u.avatar_url
      FROM api_tokens t
      JOIN users u ON t.user_id = u.id
      WHERE t.token_hash = ?
    `).bind(tokenHash).first<UserDbRow & { token_id: string }>();

    if (!tokenRow) return null;

    // Update last_used_at
    const now = new Date().toISOString();
    try {
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
          .bind(now, tokenRow.token_id)
          .run()
      );
    } catch {
      await c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
        .bind(now, tokenRow.token_id)
        .run();
    }

    const sessionUser: UserSession = {
      userId: tokenRow.id,
      githubId: tokenRow.github_id,
      handle: tokenRow.handle,
      name: tokenRow.name,
      email: tokenRow.email,
      avatarUrl: tokenRow.avatar_url
    };

    c.set("user", sessionUser);
    c.set("authMethod", "token");
    return sessionUser;
  }

  // 2. Try session cookie
  const sessionId = getCookie(c, "skillapt_session");
  if (sessionId) {
    const sessionRow = await c.env.DB.prepare(`
      SELECT 
        s.id as session_id, s.expires_at,
        u.id, u.github_id, u.handle, u.name, u.email, u.avatar_url
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ?
    `).bind(sessionId).first<UserDbRow & { session_id: string; expires_at: string }>();

    if (!sessionRow) return null;

    // Check expiration
    if (new Date(sessionRow.expires_at).getTime() < Date.now()) {
      return null;
    }

    const sessionUser: UserSession = {
      userId: sessionRow.id,
      githubId: sessionRow.github_id,
      handle: sessionRow.handle,
      name: sessionRow.name,
      email: sessionRow.email,
      avatarUrl: sessionRow.avatar_url
    };

    c.set("user", sessionUser);
    c.set("authMethod", "session");
    return sessionUser;
  }

  return null;
}

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const user = await authenticate(c);
  if (!user) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required. Provide a valid Bearer token or session."
        }
      },
      401
    );
  }
  return next();
}
