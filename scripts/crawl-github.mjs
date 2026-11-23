#!/usr/bin/env node
// Crawl public GitHub repositories for SKILL.md files and index them (metadata
// plus a source link only) through the registry's admin ingest endpoint.
//
//   GITHUB_TOKEN=... node scripts/crawl-github.mjs                    # dry run: prints what it would send
//   GITHUB_TOKEN=... REGISTRY_URL=... REGISTRY_ADMIN_TOKEN=... \
//     node scripts/crawl-github.mjs --apply                           # actually ingest
//
// Options (env): MAX_ITEMS (default 1000 per run), SHARDS (comma-separated extra search qualifiers).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toIngestEntry } from "./lib/crawl.mjs";

const APPLY = process.argv.includes("--apply");
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 1000);
const BATCH = 50;
const GH = "https://api.github.com";
const UA = "skillapt-crawler (+https://github.com/Ankur17nith/skillapt-registry)";

const ghToken = process.env.GITHUB_TOKEN;
const registry = (process.env.REGISTRY_URL || "").replace(/\/$/, "");
const adminToken = process.env.REGISTRY_ADMIN_TOKEN;

if (!ghToken) fail("GITHUB_TOKEN is required (code search needs authentication).");
if (APPLY && (!registry || !adminToken)) fail("--apply needs REGISTRY_URL and REGISTRY_ADMIN_TOKEN.");
if (APPLY && !registry.startsWith("https://")) fail("REGISTRY_URL must be https.");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url, accept = "application/vnd.github+json") {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: accept, "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" }
    });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = Math.min(Math.max(reset - Date.now(), 5000), 90000) || 30000;
      console.warn(`rate limited, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) return null;
    return accept.includes("raw") ? res.text() : res.json();
  }
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const optOutPath = path.join(here, "crawler-optout.txt");
const optOutOwners = fs.existsSync(optOutPath)
  ? fs.readFileSync(optOutPath, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
  : [];

// GitHub returns at most 1000 results per query, so split the search into shards.
const shards = (process.env.SHARDS ? process.env.SHARDS.split(",") : [
  "path:.claude/skills", "path:skills", "path:.agents/skills", "size:<600", "size:600..1200", "size:1200..3000", "size:>3000"
]).map((s) => s.trim());

const repoCache = new Map();
async function repoInfo(full) {
  if (repoCache.has(full)) return repoCache.get(full);
  const r = await gh(`${GH}/repos/${full}`);
  let info = null;
  if (r) {
    const commit = await gh(`${GH}/repos/${full}/commits/${encodeURIComponent(r.default_branch)}`);
    info = {
      owner: r.owner.login,
      name: r.name,
      url: r.html_url,
      license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : "NOASSERTION",
      topics: r.topics || [],
      fork: r.fork,
      archived: r.archived,
      headSha: commit?.sha
    };
  }
  repoCache.set(full, info);
  return info;
}

async function* findSkillFiles() {
  for (const shard of shards) {
    for (let page = 1; page <= 10; page++) {
      const q = encodeURIComponent(`filename:SKILL.md ${shard}`);
      const data = await gh(`${GH}/search/code?q=${q}&per_page=100&page=${page}`);
      await sleep(7000); // code search allows ~10 requests per minute
      if (!data || !data.items?.length) break;
      for (const item of data.items) yield item;
      if (data.items.length < 100) break;
    }
  }
}

const entries = [];
const skipped = {};
const seen = new Set();
for await (const item of findSkillFiles()) {
  if (entries.length >= MAX_ITEMS) break;
  const full = item.repository.full_name;
  const key = `${full}:${item.path}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const repo = await repoInfo(full);
  if (!repo) continue;
  const markdown = await gh(`${GH}/repos/${full}/contents/${item.path.split("/").map(encodeURIComponent).join("/")}`, "application/vnd.github.raw");
  if (!markdown) continue;

  const result = toIngestEntry({ repo, path: item.path, sha: repo.headSha, markdown, optOutOwners });
  if (result.skip) skipped[result.skip] = (skipped[result.skip] || 0) + 1;
  else entries.push(result.entry);
}

console.log(`Found ${entries.length} indexable skills. Skipped: ${JSON.stringify(skipped)}`);
if (!APPLY) {
  console.log("Dry run. First entries:\n" + JSON.stringify(entries.slice(0, 3), null, 2));
  process.exit(0);
}

let created = 0, updated = 0, rejected = 0;
for (let i = 0; i < entries.length; i += BATCH) {
  const res = await fetch(`${registry}/v1/admin/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ skills: entries.slice(i, i + BATCH) })
  });
  if (!res.ok) fail(`Ingest failed with HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  created += body.created; updated += body.updated; rejected += body.rejected.length;
  await sleep(500);
}
console.log(`Ingested: ${created} created, ${updated} updated, ${rejected} rejected.`);
