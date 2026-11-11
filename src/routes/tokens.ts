import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { computeSha256 } from "../utils/crypto";
import type { Env } from "../types";

export const tokensRouter = new Hono<{ Bindings: Env }>();

export const meRouter = new Hono<{ Bindings: Env }>();

function generateTokenHex(bytesCount = 16): string {
  const bytes = new Uint8Array(bytesCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// GET /v1/me - Get current user profile
meRouter.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const fullUser = await c.env.DB.prepare(
    "SELECT id, handle, name, email, avatar_url, created_at FROM users WHERE id = ?"
  ).bind(user.userId).first<{
    id: string;
    handle: string;
    name: string;
    email: string | null;
    avatar_url: string;
    created_at: string;
  }>();

  if (!fullUser) {
    return c.json({ error: { code: "NOT_FOUND", message: "User not found." } }, 404);
  }

  return c.json({
    id: fullUser.id,
    handle: fullUser.handle,
    name: fullUser.name,
    email: fullUser.email,
    avatarUrl: fullUser.avatar_url,
    createdAt: fullUser.created_at
  });
});

// Protect tokens routes with requireAuth
tokensRouter.use("*", requireAuth);

// GET /v1/tokens - List user's API tokens
tokensRouter.get("/", async (c) => {
  const user = c.get("user");

  const tokens = await c.env.DB.prepare(
    "SELECT id, name, prefix, expires_at, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(user.userId).all<{
    id: string;
    name: string;
    prefix: string;
    expires_at: string | null;
    created_at: string;
    last_used_at: string | null;
  }>();

  return c.json({
    tokens: (tokens.results || []).map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      expiresAt: t.expires_at,
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at
    }))
  });
});

// POST /v1/tokens - Create a new API token
tokensRouter.post("/", async (c) => {
  const authMethod = c.get("authMethod");
  if (authMethod !== "session") {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Creating API tokens requires an active cookie session."
        }
      },
      403
    );
  }

  const user = c.get("user");

  let body: { name?: string; expiresAt?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Request body must be valid JSON containing a 'name' field."
        }
      },
      400
    );
  }

  const name = body.name?.trim();
  if (!name || name.length < 1 || name.length > 50) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Token name is required and must be between 1 and 50 characters."
        }
      },
      400
    );
  }

  const now = new Date().toISOString();

  // Enforce max 20 active tokens per user
  const activeCount = (await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).bind(user.userId, now).first<number>("count")) ?? 0;

  if (activeCount >= 20) {
    return c.json(
      {
        error: {
          code: "LIMIT_EXCEEDED",
          message: "Maximum limit of 20 active API tokens reached. Revoke an existing token first."
        }
      },
      400
    );
  }

  // Handle optional expiresAt (default 90 days)
  let expiresAt: string;
  if (body.expiresAt) {
    const expDate = new Date(body.expiresAt);
    if (isNaN(expDate.getTime()) || expDate.getTime() <= Date.now()) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "expiresAt must be a valid future ISO 8601 date timestamp."
          }
        },
        400
      );
    }
    expiresAt = expDate.toISOString();
  } else {
    expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  // Generate token: apt_live_...
  const randomHex = generateTokenHex(16); // 32 hex chars
  const rawToken = `apt_live_${randomHex}`;
  const prefix = `apt_live_${randomHex.slice(0, 4)}`;
  const tokenHash = await computeSha256(new TextEncoder().encode(rawToken));
  const tokenId = `tok_${generateTokenHex(8)}`;

  await c.env.DB.prepare(`
    INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, expires_at, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).bind(tokenId, user.userId, name, prefix, tokenHash, expiresAt, now).run();

  return c.json(
    {
      id: tokenId,
      name,
      token: rawToken,
      expiresAt,
      createdAt: now,
      warning: "Copy this token now. It will not be shown again."
    },
    201
  );
});

// DELETE /v1/tokens/:id - Revoke an API token
tokensRouter.delete("/:id", async (c) => {
  const authMethod = c.get("authMethod");
  if (authMethod !== "session") {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Revoking API tokens requires an active cookie session."
        }
      },
      403
    );
  }

  const user = c.get("user");
  const tokenId = c.req.param("id");

  const existing = await c.env.DB.prepare(
    "SELECT id FROM api_tokens WHERE id = ? AND user_id = ?"
  ).bind(tokenId, user.userId).first<{ id: string }>();

  if (!existing) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `API token '${tokenId}' was not found.`
        }
      },
      404
    );
  }

  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
    .bind(tokenId, user.userId)
    .run();

  return c.json({
    message: "Token successfully revoked."
  });
});
