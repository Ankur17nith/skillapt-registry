import { Hono } from "hono";
import type { Env } from "../types";
import { requireAdmin } from "../middleware/auth";
import { recomputeLatestVersion } from "./skills";

export const adminRouter = new Hono<{ Bindings: Env }>();

// All admin routes require admin role
adminRouter.use("*", requireAdmin);

function normalizeSkillName(rawName: string): string {
  try {
    return decodeURIComponent(rawName);
  } catch {
    return rawName;
  }
}

// 1. POST /v1/admin/skills/:name/:version/takedown
adminRouter.post("/skills/:name/:version/takedown", async (c) => {
  const user = c.get("user");
  const skillName = normalizeSkillName(c.req.param("name"));
  const versionParam = c.req.param("version");

  const versionRow = await c.env.DB.prepare(
    "SELECT id, skill_name, version FROM skill_versions WHERE skill_name = ? AND version = ?"
  ).bind(skillName, versionParam).first<{ id: string; skill_name: string; version: string }>();

  if (!versionRow) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Version '${versionParam}' of skill '${skillName}' was not found.`
        }
      },
      404
    );
  }

  let body: { reason?: string; reportId?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // optional body
  }

  const reason = body.reason?.trim() || "Administrative takedown";
  const reportId = body.reportId?.trim() || null;
  const now = new Date().toISOString();
  const auditId = `aud_${crypto.randomUUID()}`;

  // Update version status to removed
  await c.env.DB.prepare(`
    UPDATE skill_versions
    SET status = 'removed', removal_reason = ?, removed_at = ?
    WHERE skill_name = ? AND version = ?
  `).bind(reason, now, skillName, versionParam).run();

  // If report ID provided, mark report resolved
  if (reportId) {
    await c.env.DB.prepare(
      "UPDATE reports SET status = 'resolved' WHERE id = ?"
    ).bind(reportId).run();
  }

  // Audit log
  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    auditId,
    user.userId,
    "skill_version.takedown",
    `${skillName}@${versionParam}`,
    JSON.stringify({ reason, reportId }),
    now
  ).run();

  // Recompute skills latest_version
  await recomputeLatestVersion(c.env.DB, skillName);

  return c.json({
    name: skillName,
    version: versionParam,
    status: "removed",
    message: `Version ${versionParam} of skill '${skillName}' has been removed.`
  });
});

// 2. POST /v1/admin/skills/:name/:version/restore
adminRouter.post("/skills/:name/:version/restore", async (c) => {
  const user = c.get("user");
  const skillName = normalizeSkillName(c.req.param("name"));
  const versionParam = c.req.param("version");

  const versionRow = await c.env.DB.prepare(
    "SELECT id, skill_name, version, yanked FROM skill_versions WHERE skill_name = ? AND version = ?"
  ).bind(skillName, versionParam).first<{ id: string; skill_name: string; version: string; yanked: number }>();

  if (!versionRow) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Version '${versionParam}' of skill '${skillName}' was not found.`
        }
      },
      404
    );
  }

  const restoredStatus = versionRow.yanked === 1 ? "yanked" : "active";
  const now = new Date().toISOString();
  const auditId = `aud_${crypto.randomUUID()}`;

  await c.env.DB.prepare(`
    UPDATE skill_versions
    SET status = ?, removal_reason = NULL, removed_at = NULL
    WHERE skill_name = ? AND version = ?
  `).bind(restoredStatus, skillName, versionParam).run();

  // Audit log
  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).bind(
    auditId,
    user.userId,
    "skill_version.restore",
    `${skillName}@${versionParam}`,
    now
  ).run();

  // Recompute skills latest_version
  await recomputeLatestVersion(c.env.DB, skillName);

  return c.json({
    name: skillName,
    version: versionParam,
    status: restoredStatus,
    message: `Version ${versionParam} of skill '${skillName}' has been restored.`
  });
});

// 3. GET /v1/admin/reports
adminRouter.get("/reports", async (c) => {
  const statusParam = c.req.query("status")?.trim();
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10) || 50));
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10) || 0);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (statusParam && statusParam !== "all") {
    conditions.push("status = ?");
    params.push(statusParam);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countSql = `SELECT COUNT(*) as total FROM reports ${whereClause}`;
  const total = (await c.env.DB.prepare(countSql).bind(...params).first<number>("total")) ?? 0;

  const querySql = `
    SELECT id, skill_name, version, reason, details, reporter_hash, status, created_at
    FROM reports
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const rows = await c.env.DB.prepare(querySql).bind(...params, limit, offset).all<any>();

  return c.json({
    reports: rows.results || [],
    total,
    limit,
    offset
  });
});

// 4. POST /v1/admin/reports/:id/resolve
adminRouter.post("/reports/:id/resolve", async (c) => {
  const user = c.get("user");
  const reportId = c.req.param("id");

  const reportRow = await c.env.DB.prepare(
    "SELECT id FROM reports WHERE id = ?"
  ).bind(reportId).first<{ id: string }>();

  if (!reportRow) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Report '${reportId}' was not found.`
        }
      },
      404
    );
  }

  let body: { notes?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // optional body
  }

  const now = new Date().toISOString();
  const auditId = `aud_${crypto.randomUUID()}`;

  await c.env.DB.prepare(
    "UPDATE reports SET status = 'resolved' WHERE id = ?"
  ).bind(reportId).run();

  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    auditId,
    user.userId,
    "report.resolve",
    reportId,
    JSON.stringify({ notes: body.notes || null }),
    now
  ).run();

  return c.json({
    id: reportId,
    status: "resolved",
    message: `Report '${reportId}' resolved successfully.`
  });
});
