import { Hono } from "hono";
import type { Env } from "../types";
import { requireAdmin } from "../middleware/auth";
import { recomputeLatestVersion } from "./skills";
import {
  IngestBodySchema,
  IngestSkillSchema,
  normalizeIngestSkill,
  type NormalizedIngestSkill
} from "../validation/ingest";

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

// POST /v1/admin/ingest - batch upsert of crawled skills (metadata and a source link only).
//
// Idempotent on the source key (source_url + source_path). A crawled listing is
// only ever refreshed while it is still unclaimed; once an owner has claimed it,
// or when the name belongs to a published skill, the crawler leaves it alone.
adminRouter.post("/ingest", async (c) => {
  const user = c.get("user");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: { code: "BAD_REQUEST", message: "Body must be JSON." } }, 400);
  }

  const parsed = IngestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Provide { skills: [...] } with 1-50 entries." } },
      400
    );
  }

  const accepted: NormalizedIngestSkill[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const entry of parsed.data.skills) {
    const result = IngestSkillSchema.safeParse(entry);
    const label = typeof (entry as { name?: unknown })?.name === "string" ? (entry as { name: string }).name : "?";
    if (!result.success) {
      rejected.push({ name: label, reason: result.error.issues[0]?.message ?? "invalid" });
    } else {
      accepted.push(normalizeIngestSkill(result.data));
    }
  }

  // One read to learn which names exist and who holds them.
  const names = accepted.map((s) => s.name);
  const existingRows = names.length
    ? await c.env.DB.prepare(
        `SELECT name, source, claim_status, source_url, source_path FROM skills WHERE name IN (${names.map(() => "?").join(",")})`
      ).bind(...names).all<{
        name: string;
        source: string | null;
        claim_status: string | null;
        source_url: string | null;
        source_path: string | null;
      }>()
    : { results: [] };
  const existing = new Map((existingRows.results || []).map((r) => [r.name, r]));

  const now = new Date().toISOString();
  const statements: ReturnType<typeof c.env.DB.prepare>[] = [];
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();

  for (const skill of accepted) {
    if (seen.has(skill.name)) {
      rejected.push({ name: skill.name, reason: "duplicate in batch" });
      continue;
    }
    seen.add(skill.name);

    const row = existing.get(skill.name);
    if (!row) {
      statements.push(
        c.env.DB.prepare(`
          INSERT INTO skills (
            name, owner_id, description, license, repository, category, keywords, compatibility,
            downloads, verified, readme, source, claim_status, source_url, source_path, source_sha,
            source_owner, crawled_at, created_at, updated_at
          ) VALUES (?, 'usr_crawler', ?, ?, ?, ?, ?, ?, 0, 0, '', 'crawled', 'unclaimed', ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          skill.name, skill.description, skill.license, skill.sourceUrl, skill.category,
          JSON.stringify(skill.keywords), JSON.stringify(skill.compatibility),
          skill.sourceUrl, skill.sourcePath, skill.sourceSha, skill.sourceOwner, now, now, now
        )
      );
      created++;
    } else if (
      row.source === "crawled" &&
      row.claim_status === "unclaimed" &&
      row.source_url === skill.sourceUrl &&
      (row.source_path ?? "") === skill.sourcePath
    ) {
      statements.push(
        c.env.DB.prepare(`
          UPDATE skills SET description = ?, license = ?, category = ?, keywords = ?, compatibility = ?,
            source_sha = ?, crawled_at = ?, updated_at = ?
          WHERE name = ? AND source = 'crawled' AND claim_status = 'unclaimed'
        `).bind(
          skill.description, skill.license, skill.category, JSON.stringify(skill.keywords),
          JSON.stringify(skill.compatibility), skill.sourceSha, now, now, skill.name
        )
      );
      updated++;
    } else {
      rejected.push({
        name: skill.name,
        reason: row.source === "crawled" && row.claim_status !== "unclaimed" ? "claimed by owner" : "name taken"
      });
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
    VALUES (?, ?, 'skills.ingest', 'crawler', ?, ?)
  `).bind(
    `audit_${crypto.randomUUID()}`, user.userId,
    JSON.stringify({ created, updated, rejected: rejected.length }), now
  ).run();

  return c.json({ created, updated, rejected });
});
