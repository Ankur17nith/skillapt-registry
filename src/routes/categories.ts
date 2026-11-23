import { Hono } from "hono";
import type { Env } from "../types";
import { CATEGORIES } from "../taxonomy";

export const categoriesRouter = new Hono<{ Bindings: Env }>();

// GET /v1/categories[?format=text] - what skills are for, with counts.
categoriesRouter.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT category, COUNT(*) AS total FROM skills GROUP BY category"
  ).all<{ category: string; total: number }>();
  const counts = new Map((rows.results || []).map((r) => [r.category, r.total]));

  const categories = CATEGORIES.map((cat) => ({
    id: cat.id,
    label: cat.label,
    description: cat.description,
    count: counts.get(cat.id) ?? 0
  }));

  // Counts scan the whole table, so let the edge cache absorb repeat reads.
  c.header("Cache-Control", "public, max-age=300");

  if (c.req.query("format") === "text") {
    const lines = categories.map(
      (cat) => `${cat.id} (${cat.count}): ${cat.description}\n  search: skillapt search --category ${cat.id} "<what you need>"`
    );
    return c.text(`Skill categories\n\n${lines.join("\n")}\n`);
  }

  return c.json({ categories });
});
