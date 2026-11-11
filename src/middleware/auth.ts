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
  role: string;
}

export function isAllowedOrigin(originOrReferer: string | undefined, env?: Env): boolean {
  if (!originOrReferer) return false;
  const rawOrigins = env?.CORS_ORIGIN || "http://localhost:3000,http://localhost:5173,https://skillapt.dev";
  const originsList = rawOrigins.split(",").map((o) => o.trim()).filter(Boolean);

  let allowed = originsList;
  if (env?.ENVIRONMENT === "production") {
    allowed = originsList.filter((o) => !o.includes("localhost") && !o.includes("127.0.0.1"));
  }

  try {
    const parsed = new URL(originOrReferer);
    return allowed.includes(parsed.origin);
  } catch {
    return allowed.includes(originOrReferer);
  }
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
        t.id as token_id, t.user_id, t.expires_at,
        u.id, u.github_id, u.handle, u.name, u.email, u.avatar_url, u.role
      FROM api_tokens t
      JOIN users u ON t.user_id = u.id
      WHERE t.token_hash = ?
    `).bind(tokenHash).first<UserDbRow & { token_id: string; expires_at: string | null }>();

    if (!tokenRow) return null;

    // Enforce token expiration
    if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return null;
    }

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
      avatarUrl: tokenRow.avatar_url,
      role: tokenRow.role || "user"
    };

    c.set("user", sessionUser);
    c.set("authMethod", "token");
    return sessionUser;
  }

  // 2. Try session cookie
  const rawSessionId = getCookie(c, "skillapt_session");
  if (rawSessionId) {
    const sessionHash = await computeSha256(new TextEncoder().encode(rawSessionId));

    const sessionRow = await c.env.DB.prepare(`
      SELECT 
        s.id as session_id, s.expires_at,
        u.id, u.github_id, u.handle, u.name, u.email, u.avatar_url, u.role
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ?
    `).bind(sessionHash).first<UserDbRow & { session_id: string; expires_at: string }>();

    if (!sessionRow) return null;

    // Check expiration and delete expired session on lookup
    if (new Date(sessionRow.expires_at).getTime() < Date.now()) {
      try {
        await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionHash).run();
      } catch {
        // ignore delete failure
      }
      return null;
    }

    const sessionUser: UserSession = {
      userId: sessionRow.id,
      githubId: sessionRow.github_id,
      handle: sessionRow.handle,
      name: sessionRow.name,
      email: sessionRow.email,
      avatarUrl: sessionRow.avatar_url,
      role: sessionRow.role || "user"
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

  // Cache-Control: no-store on authenticated routes
  c.header("Cache-Control", "no-store");

  // CSRF protection for cookie-authenticated state-changing requests
  const authMethod = c.get("authMethod");
  if (authMethod === "session" && ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("Origin") || c.req.header("Referer");
    if (!isAllowedOrigin(origin, c.env)) {
      return c.json(
        {
          error: {
            code: "CSRF_VIOLATION",
            message: "Cross-site request forgery protection: Origin or Referer does not match allowed origins."
          }
        },
        403
      );
    }
  }

  return next();
}

export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
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

  c.header("Cache-Control", "no-store");

  // CSRF protection for cookie-authenticated state-changing requests
  const authMethod = c.get("authMethod");
  if (authMethod === "session" && ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("Origin") || c.req.header("Referer");
    if (!isAllowedOrigin(origin, c.env)) {
      return c.json(
        {
          error: {
            code: "CSRF_VIOLATION",
            message: "Cross-site request forgery protection: Origin or Referer does not match allowed origins."
          }
        },
        403
      );
    }
  }

  if (user.role !== "admin") {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Admin role required to perform this action."
        }
      },
      403
    );
  }
  return next();
}
