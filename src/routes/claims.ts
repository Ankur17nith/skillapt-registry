import { Hono } from "hono";
import type { Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { rateLimit, getClientIp } from "../middleware/rate-limit";

export const claimsRouter = new Hono<{ Bindings: Env }>();

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * POST /v1/skills/:name/claim
 *
 * A signed-in GitHub user takes over a crawled, unclaimed listing. The claim is
 * approved only when the repository's GitHub owner is the signed-in user, which
 * is the same identity the registry already trusts for `@scope` ownership.
 * Organisation-owned repositories are not auto-approved yet; they can be
 * claimed by publishing from the matching scope or via an admin.
 */
claimsRouter.post(
  "/:name/claim",
  requireAuth,
  rateLimit({
    windowMs: 60 * 60 * 1000,
    maxRequests: 20,
    keyGenerator: (c) => `claim:${c.get("user")?.userId || getClientIp(c)}`
  }),
  async (c) => {
    const user = c.get("user");
    const name = decodeName(c.req.param("name") ?? "");

    const skill = await c.env.DB.prepare(
      "SELECT name, owner_id, source, claim_status, source_owner FROM skills WHERE name = ?"
    ).bind(name).first<{
      name: string;
      owner_id: string;
      source: string | null;
      claim_status: string | null;
      source_owner: string | null;
    }>();

    if (!skill) {
      return c.json({ error: { code: "NOT_FOUND", message: `Skill '${name}' does not exist.` } }, 404);
    }

    if (skill.source !== "crawled" || skill.claim_status !== "unclaimed") {
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message:
              skill.owner_id === user.userId
                ? `You already own '${name}'.`
                : `'${name}' is not an unclaimed listing, so it cannot be claimed.`
          }
        },
        409
      );
    }

    if (!skill.source_owner || skill.source_owner.toLowerCase() !== user.handle.toLowerCase()) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Only the GitHub owner of the source repository ('${skill.source_owner ?? "unknown"}') can claim '${name}'. You are signed in as '${user.handle}'.`
          }
        },
        403
      );
    }

    const now = new Date().toISOString();
    const statements = [
      c.env.DB.prepare(
        "UPDATE skills SET owner_id = ?, claim_status = 'claimed', updated_at = ? WHERE name = ? AND claim_status = 'unclaimed'"
      ).bind(user.userId, now, name),
      c.env.DB.prepare(`
        INSERT INTO skill_claims (id, skill_name, user_id, method, status, detail, created_at)
        VALUES (?, ?, ?, 'github-owner', 'approved', ?, ?)
      `).bind(`claim_${crypto.randomUUID()}`, name, user.userId, `Repository owner ${skill.source_owner}`, now),
      c.env.DB.prepare(`
        INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
        VALUES (?, ?, 'skill.claim', ?, ?, ?)
      `).bind(`audit_${crypto.randomUUID()}`, user.userId, name, JSON.stringify({ method: "github-owner" }), now)
    ];

    // Make sure the claimant holds their own scope so they can publish under it.
    if (name.startsWith("@")) {
      statements.push(
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO scopes (scope, owner_id, github_id, created_at) VALUES (?, ?, ?, ?)"
        ).bind(user.handle.toLowerCase(), user.userId, user.githubId, now)
      );
    }

    await c.env.DB.batch(statements);

    return c.json({
      name,
      claimStatus: "claimed",
      owner: { handle: user.handle },
      message: `You now own '${name}'. Publish with 'skillapt publish' to ship versions.`
    });
  }
);
