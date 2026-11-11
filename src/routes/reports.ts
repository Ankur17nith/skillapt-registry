import { Hono } from "hono";
import { rateLimit, getClientIp } from "../middleware/rate-limit";
import type { Env } from "../types";

export const reportsRouter = new Hono<{ Bindings: Env }>();

// Rate limit reports: 5 requests per hour per IP
reportsRouter.use(
  "*",
  rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 5,
    keyGenerator: (c) => `reports:${getClientIp(c)}`
  })
);

function generateReportId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `rep_${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const ALLOWED_REASONS = new Set(["malware", "spam", "abusive", "license_violation", "other"]);

// POST /v1/reports - Submit a skill report
reportsRouter.post("/", async (c) => {
  let body: {
    skillName?: string;
    version?: string;
    reason?: string;
    details?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Request body must be valid JSON."
        }
      },
      400
    );
  }

  const skillName = body.skillName?.trim();
  const version = body.version?.trim();
  const reason = body.reason?.trim();
  const details = body.details?.trim();

  if (!skillName || !version || !reason || !details) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Fields 'skillName', 'version', 'reason', and 'details' are required."
        }
      },
      400
    );
  }

  if (!ALLOWED_REASONS.has(reason)) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: `Reason must be one of: ${Array.from(ALLOWED_REASONS).join(", ")}`
        }
      },
      400
    );
  }

  // Check if skill exists
  const skill = await c.env.DB.prepare("SELECT name FROM skills WHERE name = ?")
    .bind(skillName)
    .first();

  if (!skill) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Skill '${skillName}' does not exist.`
        }
      },
      404
    );
  }

  const reporterIp = getClientIp(c);

  const reportId = generateReportId();
  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    INSERT INTO reports (id, skill_name, version, reason, details, reporter_ip, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(reportId, skillName, version, reason, details, reporterIp, now).run();

  return c.json(
    {
      id: reportId,
      message: "Report received and queued for review. Thank you for keeping the registry safe."
    },
    201
  );
});
