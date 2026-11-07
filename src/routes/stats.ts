import { Hono } from "hono";
import type { Env } from "../types";

export const statsRouter = new Hono<{ Bindings: Env }>();

// GET /v1/stats - Homepage aggregates
statsRouter.get("/", async (c) => {
  const skillsCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM skills"
  ).first<number>("count") ?? 0;

  const versionsCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM skill_versions"
  ).first<number>("count") ?? 0;

  const downloadsSum = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(downloads), 0) as total FROM skills"
  ).first<number>("total") ?? 0;

  const authorsCount = await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT owner_id) as count FROM skills"
  ).first<number>("count") ?? 0;

  return c.json({
    totalSkills: skillsCount,
    totalVersions: versionsCount,
    totalDownloads: downloadsSum,
    totalAuthors: authorsCount
  });
});
