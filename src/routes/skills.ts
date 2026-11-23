import { Hono } from "hono";
import type { Env } from "../types";
import type { D1Database } from "@cloudflare/workers-types";
import semver from "semver";
import { inspectAndValidateTarball } from "../validation/tar";
import { computeSha256 } from "../utils/crypto";
import { hashClientIp } from "../utils/salt";
import { requireAuth } from "../middleware/auth";
import { rateLimit, getClientIp } from "../middleware/rate-limit";
import { LIMITS } from "../config";
import { ALLOWED_CATEGORIES } from "../validation/manifest";
import { formatSearchText, formatSkillMarkdown } from "../utils/text";

export const skillsRouter = new Hono<{ Bindings: Env }>();

const ALLOWED_SORTS = new Set(["relevance", "downloads", "name", "updated"]);

// Slack for multipart boundaries and field headers around the 5 MB archive.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Who to show as the author. Unclaimed (crawled) listings belong to the system
 * crawler user, so show the repository's GitHub owner instead.
 */
function displayOwner(row: {
  claim_status?: string;
  source_owner?: string | null;
  owner_handle?: string;
  owner_avatar?: string;
}): { handle: string; avatarUrl: string } {
  if (row.claim_status === "unclaimed" && row.source_owner) {
    return { handle: row.source_owner, avatarUrl: `https://github.com/${row.source_owner}.png` };
  }
  return { handle: row.owner_handle || "unknown", avatarUrl: row.owner_avatar || "" };
}

/**
 * Turn free text into a safe FTS5 query: each word becomes a quoted prefix
 * term and terms are OR-ed, so natural-language requests ("summarize a pdf")
 * still match, with bm25 ranking putting the best matches first.
 */
export function buildFtsQuery(input: string): string | null {
  const tokens = (input.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

interface SkillDbRow {
  name: string;
  owner_id: string;
  latest_version?: string | null;
  description: string;
  license: string;
  repository: string | null;
  category: string;
  keywords: string;
  compatibility: string;
  downloads: number;
  verified: number;
  readme: string | null;
  created_at: string;
  updated_at: string;
  owner_handle?: string;
  owner_avatar?: string;
  source?: string;
  claim_status?: string;
  source_url?: string | null;
  source_path?: string | null;
  source_sha?: string | null;
  source_owner?: string | null;
}

interface VersionDbRow {
  skill_name: string;
  version: string;
  sha256: string;
  size: number;
  tarball_path: string;
  yanked: number;
  yank_reason: string | null;
  status?: string;
  removal_reason?: string | null;
  removed_at?: string | null;
  permissions: string;
  published_by: string;
  published_at: string;
}

interface DependencyDbRow {
  skill_name: string;
  version: string;
  dep_name: string;
  dep_version_range: string;
}

function getTarballUrl(c: { req: { url: string } }, skillName: string, version: string): string {
  const url = new URL(c.req.url);
  return `${url.origin}/v1/skills/${encodeURIComponent(skillName)}/-/${version}.tgz`;
}

async function readSizeCappedBody(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(
            `Payload size exceeds maximum allowed upload limit of ${Math.round(maxBytes / (1024 * 1024))} MB.`
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function recomputeLatestVersion(db: D1Database, skillName: string): Promise<string | null> {
  const versionsResult = await db.prepare(
    "SELECT version, yanked, status FROM skill_versions WHERE skill_name = ?"
  ).bind(skillName).all<{ version: string; yanked: number; status?: string }>();

  const activeVersions = (versionsResult.results || [])
    .filter((v: { yanked: number; status?: string }) => v.yanked === 0 && v.status !== "removed")
    .map((v: { version: string }) => v.version);

  const stableVersions = activeVersions.filter((v: string) => semver.prerelease(v) === null);
  stableVersions.sort(semver.rcompare);

  let latest: string | null = null;
  if (stableVersions.length > 0) {
    latest = stableVersions[0];
  } else if (activeVersions.length > 0) {
    activeVersions.sort(semver.rcompare);
    latest = activeVersions[0];
  }

  await db.prepare(
    "UPDATE skills SET latest_version = ? WHERE name = ?"
  ).bind(latest, skillName).run();

  return latest;
}

// 1. GET /v1/skills - List & Search
skillsRouter.get(
  "/",
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 60,
    keyGenerator: (c) => `search:${getClientIp(c)}`
  }),
  async (c) => {
    let q = c.req.query("q")?.trim() || "";
    if (q.length > 100) {
      q = q.slice(0, 100);
    }

    const hasQuery = Boolean(q);
    const sort = c.req.query("sort") || (hasQuery ? "relevance" : "downloads");
    if (!ALLOWED_SORTS.has(sort)) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Invalid sort parameter. Allowed: relevance, downloads, name, updated"
          }
        },
        400
      );
    }

    const category = c.req.query("category")?.trim();
    if (category && !ALLOWED_CATEGORIES.has(category)) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: `Invalid category. Allowed: ${Array.from(ALLOWED_CATEGORIES).join(", ")}`
          }
        },
        400
      );
    }

    const compat = c.req.query("compat")?.trim();
    const verifiedStr = c.req.query("verified")?.trim();
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10) || 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];

    let ftsQuery: string | null = null;
    if (q) {
      ftsQuery = buildFtsQuery(q);
      if (!ftsQuery) {
        return c.json({
          skills: [],
          pagination: { page, limit, total: 0, totalPages: 1 }
        });
      }
      conditions.push("skills_fts MATCH ?");
      params.push(ftsQuery);
    }

    if (category) {
      conditions.push("s.category = ?");
      params.push(category);
    }

    if (compat) {
      conditions.push("s.compatibility LIKE ? ESCAPE '\\'");
      params.push(`%"${escapeLike(compat)}"%`);
    }

    if (verifiedStr !== undefined && verifiedStr !== "") {
      const verifiedVal = verifiedStr === "true" || verifiedStr === "1" ? 1 : 0;
      conditions.push("s.verified = ?");
      params.push(verifiedVal);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const fromClause = ftsQuery
      ? "skills s JOIN skills_fts ON skills_fts.rowid = s.rowid"
      : "skills s";

    // Sort order (relevance only applies when there is a text query)
    let orderBy = "s.downloads DESC, s.updated_at DESC";
    if (sort === "relevance" && ftsQuery) {
      orderBy = "bm25(skills_fts, 10.0, 3.0, 5.0), s.downloads DESC";
    } else if (sort === "updated") {
      orderBy = "s.updated_at DESC";
    } else if (sort === "name") {
      orderBy = "s.name ASC";
    }

    // Count total matching
    const countSql = `SELECT COUNT(*) as total FROM ${fromClause} ${whereClause}`;
    const totalCount = (await c.env.DB.prepare(countSql).bind(...params).first<number>("total")) ?? 0;

    // Fetch paginated skills joined with owner (relies on latest_version to eliminate N+1)
    const querySql = `
      SELECT 
        s.name,
        COALESCE(s.latest_version, (
          SELECT sv.version FROM skill_versions sv
          WHERE sv.skill_name = s.name AND (sv.yanked = 0 OR sv.yanked IS NULL)
          ORDER BY sv.version DESC
          LIMIT 1
        ), '0.0.0') as latest_version,
        s.description, s.license, s.category, s.keywords, s.compatibility,
        s.downloads, s.verified, s.updated_at,
        s.source, s.claim_status, s.source_url, s.source_owner,
        u.handle as owner_handle, u.avatar_url as owner_avatar
      FROM ${fromClause}
      LEFT JOIN users u ON s.owner_id = u.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const queryParams = [...params, limit, offset];
    const rows = await c.env.DB.prepare(querySql).bind(...queryParams).all<SkillDbRow>();

    const skillSummaries = (rows.results || []).map((row) => {
      let keywords: string[] = [];
      let compatibility: string[] = [];
      try {
        keywords = JSON.parse(row.keywords || "[]");
      } catch {
        keywords = [];
      }
      try {
        compatibility = JSON.parse(row.compatibility || "[]");
      } catch {
        compatibility = [];
      }

      return {
        name: row.name,
        latestVersion: row.latest_version || "0.0.0",
        description: row.description,
        license: row.license,
        category: row.category,
        keywords,
        compatibility,
        downloads: row.downloads,
        verified: Boolean(row.verified),
        source: row.source || "published",
        claimStatus: row.claim_status || "owned",
        sourceUrl: row.source_url || null,
        installCommand: `npx skillapt install ${row.name}`,
        owner: displayOwner(row),
        updatedAt: row.updated_at
      };
    });

    if (c.req.query("format") === "text") {
      return c.text(
        formatSearchText(q, category, skillSummaries, totalCount),
        200,
        { "Content-Type": "text/plain; charset=utf-8" }
      );
    }

    return c.json({
      skills: skillSummaries,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit) || 1
      }
    });
  }
);

// 2. POST /v1/skills - Publish a skill package
skillsRouter.post(
  "/",
  requireAuth,
  rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 10,
    keyGenerator: (c) => `publish:${c.get("user")?.userId || getClientIp(c)}`
  }),
  async (c) => {
  const user = c.get("user");
  const contentType = c.req.header("Content-Type") || "";

  const contentLengthStr = c.req.header("Content-Length");
  if (contentLengthStr) {
    const contentLength = parseInt(contentLengthStr, 10);
    if (!isNaN(contentLength) && contentLength > LIMITS.MAX_TARBALL_SIZE_BYTES) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `Package archive size exceeds 5 MB limit (${(
              contentLength /
              (1024 * 1024)
            ).toFixed(2)} MB).`
          }
        },
        413
      );
    }
  }

  let tarGzBytes: Uint8Array;

  try {
    if (contentType.includes("multipart/form-data")) {
      // Bound the raw request body BEFORE parsing: formData() would otherwise
      // buffer an arbitrarily large (e.g. chunked) upload in memory first.
      if (!c.req.raw.body) {
        return c.json(
          { error: { code: "BAD_REQUEST", message: "Upload body is empty." } },
          400
        );
      }
      const multipartBytes = await readSizeCappedBody(
        c.req.raw.body as ReadableStream<Uint8Array>,
        LIMITS.MAX_TARBALL_SIZE_BYTES + MULTIPART_OVERHEAD_BYTES
      );
      const formData = await new Response(multipartBytes, {
        headers: { "Content-Type": contentType }
      }).formData();
      const rawFile = formData.get("file") as unknown;
      if (!rawFile || typeof rawFile === "string" || typeof (rawFile as Blob).stream !== "function") {
        return c.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Multipart form must include 'file' field containing package .tar.gz archive."
            }
          },
          400
        );
      }
      tarGzBytes = await readSizeCappedBody(
        (rawFile as Blob).stream() as ReadableStream<Uint8Array>,
        LIMITS.MAX_TARBALL_SIZE_BYTES
      );
    } else if (contentType.includes("application/gzip") || contentType.includes("application/octet-stream")) {
      if (!c.req.raw.body) {
        return c.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Upload body is empty."
            }
          },
          400
        );
      }
      tarGzBytes = await readSizeCappedBody(
        c.req.raw.body as ReadableStream<Uint8Array>,
        LIMITS.MAX_TARBALL_SIZE_BYTES
      );
    } else {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Content-Type must be 'multipart/form-data' with 'file' field or 'application/gzip'."
          }
        },
        400
      );
    }
  } catch (err) {
    const isTooLarge = err instanceof Error && err.message.includes("exceeds maximum allowed upload limit");
    return c.json(
      {
        error: {
          code: isTooLarge ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Failed to parse uploaded archive payload."
        }
      },
      isTooLarge ? 413 : 400
    );
  }

  // Check upload size limit
  if (tarGzBytes.byteLength > LIMITS.MAX_TARBALL_SIZE_BYTES) {
    return c.json(
      {
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: `Package archive size exceeds 5 MB limit (${(
            tarGzBytes.byteLength /
            (1024 * 1024)
          ).toFixed(2)} MB).`
        }
      },
      413
    );
  }

  // Inspect and validate tar archive, files, and manifest
  const validation = await inspectAndValidateTarball(tarGzBytes);
  if (!validation.success || !validation.manifest) {
    return c.json(
      {
        error: {
          code: "INVALID_PACKAGE",
          message: validation.error || "Package validation failed."
        }
      },
      400
    );
  }

  const manifest = validation.manifest;

  // 1. Check scope ownership for scoped packages
  if (manifest.name.startsWith("@")) {
    const [scopePart] = manifest.name.slice(1).split("/");
    const scopeLower = scopePart.toLowerCase();

    const scopeRow = await c.env.DB.prepare(
      "SELECT scope, github_id, owner_id FROM scopes WHERE scope = ?"
    ).bind(scopeLower).first<{ scope: string; github_id: number; owner_id: string }>();

    if (!scopeRow || scopeRow.github_id !== user.githubId) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You do not own the '@${scopeLower}' scope. Only the scope owner can publish packages under this scope.`
          }
        },
        403
      );
    }
  }

  // 2. Check package ownership (unscoped packages are first-come).
  // A crawled, unclaimed listing can be taken over by the scope owner by
  // publishing to it (the scope check above proves they own the namespace).
  const existingSkill = await c.env.DB.prepare(
    "SELECT owner_id, source, claim_status FROM skills WHERE name = ?"
  ).bind(manifest.name).first<{ owner_id: string; source: string | null; claim_status: string | null }>();

  const isUnclaimedTakeover = Boolean(
    existingSkill &&
      existingSkill.owner_id !== user.userId &&
      existingSkill.source === "crawled" &&
      existingSkill.claim_status === "unclaimed" &&
      manifest.name.startsWith("@")
  );

  if (existingSkill && !isUnclaimedTakeover) {
    if (existingSkill.owner_id !== user.userId) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You do not have permission to publish new versions of '${manifest.name}'. Only the package owner can publish.`
          }
        },
        403
      );
    }
  }

  // 3. Check version immutability
  const existingVersion = await c.env.DB.prepare(
    "SELECT id FROM skill_versions WHERE skill_name = ? AND version = ?"
  ).bind(manifest.name, manifest.version).first<{ id: string }>();

  if (existingVersion) {
    return c.json(
      {
        error: {
          code: "CONFLICT",
          message: `Version ${manifest.version} of skill '${manifest.name}' has already been published and is immutable.`
        }
      },
      409
    );
  }

  // 4. Validate dependency existence, version ranges, depth, and cycles
  const declaredDeps = manifest.dependencies || {};
  const depEntries = Object.entries(declaredDeps);

  if (depEntries.length > 0) {
    async function checkDependencyGraph(
      depName: string,
      depRange: string,
      visitedChain: string[],
      currentDepth: number
    ): Promise<string | null> {
      if (currentDepth > LIMITS.MAX_DEPENDENCY_DEPTH) {
        return `Dependency depth exceeds maximum of ${LIMITS.MAX_DEPENDENCY_DEPTH} (path: ${visitedChain.join(" -> ")} -> ${depName})`;
      }

      if (visitedChain.includes(depName)) {
        return `Dependency cycle detected: ${visitedChain.join(" -> ")} -> ${depName}`;
      }

      const rows = await c.env.DB.prepare(`
        SELECT v.version, v.yanked, v.status
        FROM skill_versions v
        WHERE v.skill_name = ?
      `).bind(depName).all<{ version: string; yanked: number; status?: string }>();

      const versions = rows.results || [];
      const satisfyingVersion = versions.find((v) => {
        return v.yanked === 0 && v.status !== "removed" && semver.satisfies(v.version, depRange);
      });

      if (!satisfyingVersion) {
        return `Dependency '${depName}' with range '${depRange}' cannot be satisfied by any active published version.`;
      }

      const transitiveDeps = await c.env.DB.prepare(`
        SELECT dep_name, dep_version_range
        FROM dependencies
        WHERE skill_name = ? AND version = ?
      `).bind(depName, satisfyingVersion.version).all<{ dep_name: string; dep_version_range: string }>();

      for (const tDep of transitiveDeps.results || []) {
        const err = await checkDependencyGraph(
          tDep.dep_name,
          tDep.dep_version_range,
          [...visitedChain, depName],
          currentDepth + 1
        );
        if (err) return err;
      }

      return null;
    }

    for (const [depName, depRange] of depEntries) {
      const depError = await checkDependencyGraph(depName, depRange, [manifest.name], 1);
      if (depError) {
        return c.json(
          {
            error: {
              code: "INVALID_DEPENDENCY",
              message: depError
            }
          },
          400
        );
      }
    }
  }

  // Determine if this newly published version is the highest stable version
  const publishedIsStable = semver.prerelease(manifest.version) === null;
  const existingVersions = await c.env.DB.prepare(
    "SELECT version, yanked, status FROM skill_versions WHERE skill_name = ?"
  ).bind(manifest.name).all<{ version: string; yanked: number; status?: string }>();

  const existingActiveVersions = (existingVersions.results || [])
    .filter((v) => v.yanked === 0 && v.status !== "removed")
    .map((v) => v.version);

  const currentStableVersions = existingActiveVersions.filter((v) => semver.prerelease(v) === null);
  currentStableVersions.sort(semver.rcompare);
  const currentHighestStable = currentStableVersions[0] || null;

  let isNewHighestStable = false;
  let newLatestVersion: string;

  if (publishedIsStable) {
    if (!currentHighestStable || semver.gt(manifest.version, currentHighestStable)) {
      isNewHighestStable = true;
      newLatestVersion = manifest.version;
    } else {
      newLatestVersion = currentHighestStable;
    }
  } else {
    if (currentHighestStable) {
      newLatestVersion = currentHighestStable;
    } else {
      const allActive = [...existingActiveVersions, manifest.version];
      allActive.sort(semver.rcompare);
      newLatestVersion = allActive[0];
    }
  }

  // Compute tarball SHA-256 integrity hash
  const sha256 = await computeSha256(tarGzBytes);
  const tarballPath = `skills/${manifest.name}/${manifest.version}.tgz`;

  // Store in Cloudflare R2 with create-only semantics (fail on conflict)
  const r2Result = await c.env.STORAGE.put(tarballPath, tarGzBytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/gzip"
    }
  });

  if (!r2Result) {
    return c.json(
      {
        error: {
          code: "CONFLICT",
          message: `Version ${manifest.version} of skill '${manifest.name}' has already been published and is immutable.`
        }
      },
      409
    );
  }

  const now = new Date().toISOString();
  const statements: any[] = [];

  // Create or update skill metadata in D1
  if (!existingSkill) {
    statements.push(
      c.env.DB.prepare(`
        INSERT INTO skills (
          name, owner_id, description, license, repository, category,
          keywords, compatibility, downloads, verified, readme, latest_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
      `).bind(
        manifest.name,
        user.userId,
        manifest.description,
        manifest.license,
        manifest.repository || null,
        manifest.category,
        JSON.stringify(manifest.keywords || []),
        JSON.stringify(manifest.compatibility),
        validation.readme || "",
        newLatestVersion,
        now,
        now
      )
    );
  } else if (isNewHighestStable) {
    statements.push(
      c.env.DB.prepare(`
        UPDATE skills
        SET description = ?, license = ?, repository = ?, category = ?,
            keywords = ?, compatibility = ?, readme = ?, latest_version = ?, updated_at = ?
        WHERE name = ?
      `).bind(
        manifest.description,
        manifest.license,
        manifest.repository || null,
        manifest.category,
        JSON.stringify(manifest.keywords || []),
        JSON.stringify(manifest.compatibility),
        validation.readme || "",
        newLatestVersion,
        now,
        manifest.name
      )
    );
  } else {
    statements.push(
      c.env.DB.prepare(`
        UPDATE skills
        SET updated_at = ?
        WHERE name = ?
      `).bind(now, manifest.name)
    );
  }

  if (isUnclaimedTakeover) {
    statements.push(
      c.env.DB.prepare(
        "UPDATE skills SET owner_id = ?, source = 'published', claim_status = 'claimed' WHERE name = ?"
      ).bind(user.userId, manifest.name),
      c.env.DB.prepare(`
        INSERT INTO skill_claims (id, skill_name, user_id, method, status, detail, created_at)
        VALUES (?, ?, ?, 'publish', 'approved', ?, ?)
      `).bind(`claim_${crypto.randomUUID()}`, manifest.name, user.userId, "Scope owner published to an unclaimed listing", now)
    );
  }

  // Insert version record
  const versionId = `${manifest.name}@${manifest.version}`;
  statements.push(
    c.env.DB.prepare(`
      INSERT INTO skill_versions (
        id, skill_name, version, sha256, size, tarball_path,
        yanked, yank_reason, status, permissions, published_by, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 'active', ?, ?, ?)
    `).bind(
      versionId,
      manifest.name,
      manifest.version,
      sha256,
      tarGzBytes.byteLength,
      tarballPath,
      JSON.stringify(manifest.permissions),
      user.userId,
      now
    )
  );

  // Insert dependencies
  for (const [depName, depRange] of Object.entries(manifest.dependencies || {})) {
    const depId = `dep_${manifest.name}_${manifest.version}_${depName}`;
    statements.push(
      c.env.DB.prepare(`
        INSERT INTO dependencies (id, skill_name, version, dep_name, dep_version_range)
        VALUES (?, ?, ?, ?, ?)
      `).bind(depId, manifest.name, manifest.version, depName, depRange)
    );
  }

  // Execute single atomic D1 batch; delete R2 on failure to prevent orphans
  try {
    await c.env.DB.batch(statements);
  } catch (err) {
    await c.env.STORAGE.delete(tarballPath);
    throw err;
  }

  return c.json(
    {
      name: manifest.name,
      version: manifest.version,
      sha256,
      integrity: `sha256-${sha256}`,
      size: tarGzBytes.byteLength,
      tarballUrl: getTarballUrl(c, manifest.name, manifest.version),
      message: `Successfully published ${manifest.name}@${manifest.version}`
    },
    201
  );
});

// Helper for extracting skill name from URL params (supports encoded @scope/name)
function normalizeSkillName(rawName: string): string {
  try {
    return decodeURIComponent(rawName);
  } catch {
    return rawName;
  }
}

// 2. GET /v1/skills/:name - Detail with versions
skillsRouter.get("/:name", async (c) => {
  const skillName = normalizeSkillName(c.req.param("name"));

  const skill = await c.env.DB.prepare(`
    SELECT 
      s.*, u.handle as owner_handle, u.avatar_url as owner_avatar
    FROM skills s
    LEFT JOIN users u ON s.owner_id = u.id
    WHERE s.name = ?
  `).bind(skillName).first<SkillDbRow>();

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

  // Fetch all versions
  const versionsResult = await c.env.DB.prepare(`
    SELECT * FROM skill_versions WHERE skill_name = ?
  `).bind(skillName).all<VersionDbRow>();

  // Fetch all dependencies for this skill
  const depsResult = await c.env.DB.prepare(`
    SELECT * FROM dependencies WHERE skill_name = ?
  `).bind(skillName).all<DependencyDbRow>();

  const depsByVersion: Record<string, Record<string, string>> = {};
  for (const dep of depsResult.results || []) {
    if (!depsByVersion[dep.version]) {
      depsByVersion[dep.version] = {};
    }
    depsByVersion[dep.version][dep.dep_name] = dep.dep_version_range;
  }

  const versionsMap: Record<string, Record<string, unknown>> = {};
  const versionStrings: string[] = [];

  for (const v of versionsResult.results || []) {
    versionStrings.push(v.version);
    let permissions = { network: false, shell: false, filesystem: "none" };
    try {
      permissions = JSON.parse(v.permissions);
    } catch {
      // fallback
    }

    const isRemoved = v.status === "removed";
    const isYanked = Boolean(v.yanked);
    const status = isRemoved ? "removed" : isYanked ? "yanked" : (v.status || "active");

    const versionMeta: Record<string, unknown> = {
      version: v.version,
      sha256: v.sha256,
      integrity: `sha256-${v.sha256}`,
      size: v.size,
      dependencies: depsByVersion[v.version] || {},
      publishedAt: v.published_at,
      status,
      yanked: isYanked,
      removed: isRemoved,
      permissions
    };

    if (isRemoved) {
      versionMeta.removalReason = v.removal_reason || null;
      versionMeta.removedAt = v.removed_at || null;
    } else {
      versionMeta.tarballUrl = getTarballUrl(c, skillName, v.version);
    }

    versionsMap[v.version] = versionMeta;
  }

  // Determine latest non-yanked, non-removed version
  const nonRemovedVersions = (versionsResult.results || [])
    .filter((v) => v.status !== "removed");
  const nonYankedVersions = nonRemovedVersions
    .filter((v) => v.yanked === 0)
    .map((v) => v.version);
  const nonRemovedVersionStrings = nonRemovedVersions.map((v) => v.version);
  const candidateVersions = nonYankedVersions.length > 0 ? nonYankedVersions : nonRemovedVersionStrings;
  const latestVersion = candidateVersions.sort(semver.rcompare)[0] || "0.0.0";

  let keywords: string[] = [];
  let compatibility: string[] = [];
  try {
    keywords = JSON.parse(skill.keywords || "[]");
  } catch {
    keywords = [];
  }
  try {
    compatibility = JSON.parse(skill.compatibility || "[]");
  } catch {
    compatibility = [];
  }

  const accept = c.req.header("Accept") || "";
  if (c.req.query("format") === "md" || c.req.query("format") === "text" || accept.includes("text/markdown")) {
    c.header("Vary", "Accept");
    return c.text(
      formatSkillMarkdown({
        name: skill.name,
        description: skill.description,
        category: skill.category,
        license: skill.license,
        keywords,
        compatibility,
        latestVersion,
        downloads: skill.downloads,
        verified: Boolean(skill.verified),
        source: skill.source || "published",
        claimStatus: skill.claim_status || "owned",
        sourceUrl: skill.source_url || skill.repository || null,
        ownerHandle: displayOwner(skill).handle
      }),
      200,
      { "Content-Type": "text/markdown; charset=utf-8" }
    );
  }

  return c.json({
    name: skill.name,
    description: skill.description,
    license: skill.license,
    repository: skill.repository,
    keywords,
    category: skill.category,
    compatibility,
    source: skill.source || "published",
    claimStatus: skill.claim_status || "owned",
    sourceUrl: skill.source_url || null,
    sourcePath: skill.source_path || null,
    sourceSha: skill.source_sha || null,
    installCommand: `npx skillapt install ${skill.name}`,
    owner: displayOwner(skill),
    latestVersion,
    downloads: skill.downloads,
    versions: versionsMap,
    readme: skill.readme || "",
    createdAt: skill.created_at,
    updatedAt: skill.updated_at
  });
});

// 3. GET /v1/skills/:name/:version - Exact version metadata
skillsRouter.get("/:name/:version", async (c) => {
  const skillName = normalizeSkillName(c.req.param("name"));
  const versionParam = c.req.param("version");

  const versionRow = await c.env.DB.prepare(`
    SELECT * FROM skill_versions WHERE skill_name = ? AND version = ?
  `).bind(skillName, versionParam).first<VersionDbRow>();

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

  // Fetch dependencies for this version
  const deps = await c.env.DB.prepare(`
    SELECT dep_name, dep_version_range FROM dependencies WHERE skill_name = ? AND version = ?
  `).bind(skillName, versionParam).all<DependencyDbRow>();

  const dependencies: Record<string, string> = {};
  for (const dep of deps.results || []) {
    dependencies[dep.dep_name] = dep.dep_version_range;
  }

  let permissions = { network: false, shell: false, filesystem: "none" };
  try {
    permissions = JSON.parse(versionRow.permissions);
  } catch {
    // fallback
  }

  const isRemoved = versionRow.status === "removed";
  const isYanked = Boolean(versionRow.yanked);
  const status = isRemoved ? "removed" : isYanked ? "yanked" : (versionRow.status || "active");

  const responsePayload: Record<string, unknown> = {
    name: skillName,
    version: versionRow.version,
    sha256: versionRow.sha256,
    integrity: `sha256-${versionRow.sha256}`,
    size: versionRow.size,
    dependencies,
    publishedAt: versionRow.published_at,
    status,
    yanked: isYanked,
    removed: isRemoved,
    permissions
  };

  if (isRemoved) {
    responsePayload.removalReason = versionRow.removal_reason || null;
    responsePayload.removedAt = versionRow.removed_at || null;
  } else {
    responsePayload.tarballUrl = getTarballUrl(c, skillName, versionRow.version);
  }

  return c.json(responsePayload);
});

// 4. GET /v1/skills/:name/-/:file - Download tarball
skillsRouter.on(
  ["GET", "HEAD"],
  "/:name/-/:file",
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 120,
    keyGenerator: (c) => `download:${getClientIp(c)}`
  }),
  async (c) => {
    const isHead = c.req.method.toUpperCase() === "HEAD";
    const skillName = normalizeSkillName(c.req.param("name") || "");
    const file = c.req.param("file") || "";

    if (!file.endsWith(".tgz")) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Requested archive must have a .tgz extension."
          }
        },
        400
      );
    }

    const version = file.slice(0, -4);

    // Check version existence in database
    const versionRow = await c.env.DB.prepare(
      "SELECT * FROM skill_versions WHERE skill_name = ? AND version = ?"
    ).bind(skillName, version).first<VersionDbRow>();

    if (!versionRow) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `Package '${skillName}@${version}' not found.`
          }
        },
        404
      );
    }

    if (versionRow.status === "removed") {
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          error: {
            code: "GONE",
            message: `Version '${version}' of skill '${skillName}' has been removed by administrators.`
          },
          status: "removed",
          removed: true,
          removalReason: versionRow.removal_reason || null
        },
        410
      );
    }

    const safeFilename = `${skillName.replace(/[@/]/g, "-")}-${version}.tgz`;
    const etag = `"${versionRow.sha256}"`;
    const cacheControl = versionRow.yanked === 1
      ? "public, max-age=300"
      : "public, max-age=31536000, immutable";

    c.header("Content-Type", "application/gzip");
    c.header("Content-Disposition", `attachment; filename="${safeFilename}"`);
    c.header("ETag", etag);
    c.header("Cache-Control", cacheControl);

    // Handle If-None-Match (ETag or sha256 match) -> 304 Not Modified
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch) {
      const matchTokens = ifNoneMatch.split(",").map((t) => t.trim().replace(/^W\//, ""));
      if (
        matchTokens.includes(etag) ||
        matchTokens.includes(`"${versionRow.sha256}"`) ||
        matchTokens.includes(versionRow.sha256) ||
        matchTokens.includes("*")
      ) {
        return c.body(null, 304);
      }
    }

    // Fetch package bytes from R2
    const r2Object = await c.env.STORAGE.get(versionRow.tarball_path);
    if (!r2Object) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `Package archive file for '${skillName}@${version}' is missing from storage.`
          }
        },
        404
      );
    }

    // Dedupe download counts:
    // Skip counting for HEAD and Range requests
    const hasRange = Boolean(c.req.header("range"));
    if (!isHead && !hasRange) {
      const clientIp = getClientIp(c);
      const ipHash = await hashClientIp(c.env, clientIp);
      const day = new Date().toISOString().slice(0, 10);

      try {
        const dedupeRes = await c.env.DB.prepare(
          "INSERT OR IGNORE INTO download_dedupe (skill_name, version, ip_hash, day) VALUES (?, ?, ?, ?)"
        ).bind(skillName, version, ipHash, day).run();

        if ((dedupeRes.meta?.changes ?? 0) > 0) {
          await c.env.DB.prepare("UPDATE skills SET downloads = downloads + 1 WHERE name = ?")
            .bind(skillName)
            .run();
        }
      } catch {
        // Ignore dedupe error
      }
    }

    if (isHead) {
      return c.body(null);
    }

    // Stream R2 body directly
    return c.body(r2Object.body);
  }
);

// 5. POST /v1/skills/:name/:version/yank - Yank or unyank a version
skillsRouter.post("/:name/:version/yank", requireAuth, async (c) => {
  const user = c.get("user");
  const skillName = normalizeSkillName(c.req.param("name") || "");
  const versionParam = c.req.param("version") || "";

  // Check ownership
  const skill = await c.env.DB.prepare(
    "SELECT owner_id FROM skills WHERE name = ?"
  ).bind(skillName).first<{ owner_id: string }>();

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

  if (skill.owner_id !== user.userId) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Only the package owner can yank versions."
        }
      },
      403
    );
  }

  // Check version existence
  const versionRow = await c.env.DB.prepare(
    "SELECT id, yanked, status FROM skill_versions WHERE skill_name = ? AND version = ?"
  ).bind(skillName, versionParam).first<{ id: string; yanked: number; status?: string }>();

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

  let body: { reason?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // optional body
  }

  if (body.reason && body.reason.length > 500) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Yank reason must not exceed 500 characters."
        }
      },
      400
    );
  }

  const yankReason = body.reason?.trim() || "Yanked by owner";
  const newStatus = versionRow.status === "removed" ? "removed" : "yanked";

  await c.env.DB.prepare(`
    UPDATE skill_versions
    SET yanked = 1, status = ?, yank_reason = ?
    WHERE skill_name = ? AND version = ?
  `).bind(newStatus, yankReason, skillName, versionParam).run();

  await recomputeLatestVersion(c.env.DB, skillName);

  return c.json({
    name: skillName,
    version: versionParam,
    yanked: true,
    message: `Version ${versionParam} has been yanked.`
  });
});

// 6. DELETE /v1/skills/:name/:version/yank - Un-yank a version (idempotent)
skillsRouter.delete("/:name/:version/yank", requireAuth, async (c) => {
  const user = c.get("user");
  const skillName = normalizeSkillName(c.req.param("name") || "");
  const versionParam = c.req.param("version") || "";

  // Check ownership
  const skill = await c.env.DB.prepare(
    "SELECT owner_id FROM skills WHERE name = ?"
  ).bind(skillName).first<{ owner_id: string }>();

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

  if (skill.owner_id !== user.userId) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Only the package owner can unyank versions."
        }
      },
      403
    );
  }

  // Check version existence
  const versionRow = await c.env.DB.prepare(
    "SELECT id, yanked, status FROM skill_versions WHERE skill_name = ? AND version = ?"
  ).bind(skillName, versionParam).first<{ id: string; yanked: number; status?: string }>();

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

  const newStatus = versionRow.status === "removed" ? "removed" : "active";

  await c.env.DB.prepare(`
    UPDATE skill_versions
    SET yanked = 0, status = ?, yank_reason = NULL
    WHERE skill_name = ? AND version = ?
  `).bind(newStatus, skillName, versionParam).run();

  await recomputeLatestVersion(c.env.DB, skillName);

  return c.json({
    name: skillName,
    version: versionParam,
    yanked: false,
    message: `Version ${versionParam} has been unyanked.`
  });
});

