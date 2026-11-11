import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

function createTarHeader(entryPath, size) {
  const block = new Uint8Array(512);
  const encoder = new TextEncoder();
  block.set(encoder.encode(entryPath).subarray(0, 100), 0);
  block.set(encoder.encode("0000644\0"), 100);
  block.set(encoder.encode("0000000\0"), 108);
  block.set(encoder.encode("0000000\0"), 116);
  const sizeOctal = size.toString(8).padStart(11, "0") + " ";
  block.set(encoder.encode(sizeOctal), 124);
  block.set(encoder.encode((1762000000).toString(8).padStart(11, "0") + " "), 136);
  block[156] = "0".charCodeAt(0);
  block.set(encoder.encode("ustar\x0000"), 257);
  for (let i = 148; i < 156; i++) block[i] = " ".charCodeAt(0);
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += block[i];
  const chksumOctal = chksum.toString(8).padStart(6, "0") + "\0 ";
  block.set(encoder.encode(chksumOctal), 148);
  return block;
}

function buildDeterministicTarGz(files) {
  const chunks = [];
  for (const file of files) {
    const content = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
    const header = createTarHeader(file.path, content.length);
    chunks.push(header);
    chunks.push(content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const tar = Buffer.concat(chunks);
  return zlib.gzipSync(tar, { mtime: 0 });
}

const skillsMeta = [
  { name: "pdf-summarizer", owner: "usr_alexdev", latest: "1.2.0", desc: "Extracts text from PDF documents and generates structured agent summaries.", lic: "MIT", repo: "https://github.com/agent-skills/pdf-summarizer", cat: "documents", kw: "[\"pdf\",\"summarizer\",\"documents\",\"extraction\"]", comp: "[\"claude\",\"cursor\",\"codex\",\"antigravity\"]", dl: 1420, v: 1, rm: "# PDF Summarizer\\nExtracts text and summarizes PDF files with high fidelity.", ca: "2026-09-15T10:00:00Z", ua: "2026-11-01T12:00:00Z" },
  { name: "text-cleaner", owner: "usr_alexdev", latest: "1.0.2", desc: "Fast text normalization, whitespace cleanup, and unicode sanitization for LLM context windows.", lic: "MIT", repo: "https://github.com/agent-skills/text-cleaner", cat: "data", kw: "[\"cleaner\",\"text\",\"unicode\",\"sanitizer\"]", comp: "[\"claude\",\"cursor\",\"codex\"]", dl: 3890, v: 1, rm: "# Text Cleaner\\nCleans noisy OCR and scraped text before feeding into prompts.", ca: "2026-09-10T08:00:00Z", ua: "2026-10-25T11:00:00Z" },
  { name: "git-commit-helper", owner: "usr_sarahai", latest: "2.0.0", desc: "Generates conventional git commit messages and PR descriptions from staged diffs.", lic: "Apache-2.0", repo: "https://github.com/sarahchen/git-commit-helper", cat: "devtools", kw: "[\"git\",\"commit\",\"conventional-commits\",\"diff\"]", comp: "[\"cursor\",\"codex\",\"antigravity\"]", dl: 5230, v: 1, rm: "# Git Commit Helper\\nCreates crisp, semantic commit messages aligned with team standards.", ca: "2026-09-12T11:00:00Z", ua: "2026-11-03T16:00:00Z" },
  { name: "sql-query-generator", owner: "usr_marcusk", latest: "1.0.0", desc: "Translates natural language questions into safe, optimized SQL queries and explanations.", lic: "MIT", repo: "https://github.com/marcus/sql-query-generator", cat: "data", kw: "[\"sql\",\"database\",\"postgres\",\"sqlite\"]", comp: "[\"claude\",\"codex\",\"openai\"]", dl: 2740, v: 1, rm: "# SQL Query Generator\\nGenerates read-only analytical SQL queries with schema awareness.", ca: "2026-09-18T14:00:00Z", ua: "2026-10-30T10:00:00Z" },
  { name: "web-page-extractor", owner: "usr_sarahai", latest: "1.1.0", desc: "Safely fetches web pages, strips adverts and cookie modals, and outputs markdown for agents.", lic: "MIT", repo: "https://github.com/sarahchen/web-page-extractor", cat: "research", kw: "[\"web\",\"crawler\",\"markdown\",\"scraper\"]", comp: "[\"claude\",\"antigravity\",\"custom\"]", dl: 4120, v: 1, rm: "# Web Page Extractor\\nDistills clean readable content from any public web page.", ca: "2026-09-20T16:00:00Z", ua: "2026-11-05T09:00:00Z" },
  { name: "code-refactorer", owner: "usr_priyar", latest: "1.3.0", desc: "Performs safe architectural refactoring, extracts functions, and removes code duplication.", lic: "Apache-2.0", repo: "https://github.com/priyarao/code-refactorer", cat: "coding", kw: "[\"refactoring\",\"clean-code\",\"dry\",\"patterns\"]", comp: "[\"claude\",\"cursor\",\"codex\"]", dl: 3150, v: 1, rm: "# Code Refactorer\\nApplies SOLID principles and cleans up legacy codebases.", ca: "2026-09-22T09:00:00Z", ua: "2026-11-02T15:00:00Z" },
  { name: "changelog-builder", owner: "usr_alexdev", latest: "1.0.1", desc: "Analyzes git tags and commits to produce Markdown changelogs following Keep a Changelog.", lic: "MIT", repo: "https://github.com/agent-skills/changelog-builder", cat: "productivity", kw: "[\"changelog\",\"release\",\"git\",\"versioning\"]", comp: "[\"cursor\",\"claude\"]", dl: 1890, v: 0, rm: "# Changelog Builder\\nAutomates release notes from merged PRs and commits.", ca: "2026-09-25T13:00:00Z", ua: "2026-10-28T14:00:00Z" },
  { name: "security-rule-auditor", owner: "usr_priyar", latest: "2.1.0", desc: "Audits cloud security rules (Firestore, AWS IAM, Supabase) for privilege escalation risks.", lic: "MIT", repo: "https://github.com/priyarao/security-rule-auditor", cat: "devtools", kw: "[\"security\",\"audit\",\"rules\",\"firestore\",\"iam\"]", comp: "[\"claude\",\"antigravity\"]", dl: 2410, v: 1, rm: "# Security Rule Auditor\\nFinds open permissions, unauthenticated write routes, and logic flaws.", ca: "2026-09-28T10:00:00Z", ua: "2026-11-04T12:00:00Z" },
  { name: "mermaid-diagram-generator", owner: "usr_marcusk", latest: "1.0.0", desc: "Transforms architectural descriptions and code into valid Mermaid flowcharts and sequence charts.", lic: "MIT", repo: "https://github.com/marcus/mermaid-diagram-generator", cat: "documents", kw: "[\"mermaid\",\"diagrams\",\"charts\",\"visualization\"]", comp: "[\"claude\",\"cursor\",\"openai\"]", dl: 3620, v: 0, rm: "# Mermaid Diagram Generator\\nProduces syntactically valid diagrams ready for documentation.", ca: "2026-10-01T15:00:00Z", ua: "2026-11-01T18:00:00Z" },
  { name: "regex-optimizer", owner: "usr_alexdev", latest: "1.0.0", desc: "Synthesizes, tests, and explains high-performance regular expressions with catastrophic backtracking protection.", lic: "MIT", repo: "https://github.com/agent-skills/regex-optimizer", cat: "devtools", kw: "[\"regex\",\"re2\",\"patterns\",\"optimizer\"]", comp: "[\"claude\",\"cursor\",\"codex\"]", dl: 1650, v: 0, rm: "# Regex Optimizer\\nCreates safe, tested regex patterns without catastrophic backtracking.", ca: "2026-10-03T11:00:00Z", ua: "2026-10-29T10:00:00Z" },
  { name: "api-mock-server", owner: "usr_sarahai", latest: "1.2.0", desc: "Generates mock OpenAPI server stubs and synthetic fixtures from schemas for rapid frontend testing.", lic: "Apache-2.0", repo: "https://github.com/sarahchen/api-mock-server", cat: "devtools", kw: "[\"openapi\",\"mock\",\"stubs\",\"testing\"]", comp: "[\"cursor\",\"codex\"]", dl: 2210, v: 1, rm: "# API Mock Server\\nSpins up temporary mock APIs with realistic faker data.", ca: "2026-10-05T12:00:00Z", ua: "2026-11-02T17:00:00Z" },
  { name: "markdown-formatter", owner: "usr_alexdev", latest: "1.0.0", desc: "Standardizes markdown tables, links, headers, and code fences according to CommonMark.", lic: "MIT", repo: "https://github.com/agent-skills/markdown-formatter", cat: "documents", kw: "[\"markdown\",\"formatter\",\"commonmark\",\"docs\"]", comp: "[\"claude\",\"cursor\"]", dl: 1980, v: 0, rm: "# Markdown Formatter\\nCleans and aligns messy markdown tables and code blocks.", ca: "2026-10-08T08:00:00Z", ua: "2026-10-27T09:00:00Z" },
  { name: "dockerfile-linter", owner: "usr_marcusk", latest: "1.1.0", desc: "Inspects Dockerfiles for root user risks, caching layer bloat, and secret leaks.", lic: "MIT", repo: "https://github.com/marcus/dockerfile-linter", cat: "devtools", kw: "[\"docker\",\"dockerfile\",\"container\",\"linter\"]", comp: "[\"cursor\",\"codex\"]", dl: 1780, v: 1, rm: "# Dockerfile Linter\\nHardens container definitions and trims image footprints.", ca: "2026-10-10T14:00:00Z", ua: "2026-11-03T11:00:00Z" },
  { name: "slack-notifier", owner: "usr_sarahai", latest: "1.0.0", desc: "Sends agent progress summaries and alerts to Slack channels with interactive BlockKit formatting.", lic: "MIT", repo: "https://github.com/sarahchen/slack-notifier", cat: "communication", kw: "[\"slack\",\"webhook\",\"alerts\",\"notifications\"]", comp: "[\"claude\",\"antigravity\",\"custom\"]", dl: 1490, v: 0, rm: "# Slack Notifier\\nKeeps teams updated on agent tasks via BlockKit.", ca: "2026-10-12T16:00:00Z", ua: "2026-10-31T15:00:00Z" },
  { name: "jira-ticket-creator", owner: "usr_priyar", latest: "1.0.0", desc: "Drafts comprehensive Jira bug tickets and feature requests from error logs and stack traces.", lic: "MIT", repo: "https://github.com/priyarao/jira-ticket-creator", cat: "productivity", kw: "[\"jira\",\"tickets\",\"bugs\",\"scrum\"]", comp: "[\"claude\",\"cursor\"]", dl: 1320, v: 0, rm: "# Jira Ticket Creator\\nTurns reproduction steps and traces into clear issue tickets.", ca: "2026-10-14T09:00:00Z", ua: "2026-10-30T13:00:00Z" },
  { name: "json-schema-infer", owner: "usr_alexdev", latest: "1.0.2", desc: "Infers strict JSON schemas and TypeScript interfaces from arbitrary sample JSON payloads.", lic: "MIT", repo: "https://github.com/agent-skills/json-schema-infer", cat: "data", kw: "[\"json\",\"schema\",\"typescript\",\"types\"]", comp: "[\"claude\",\"cursor\",\"codex\"]", dl: 2890, v: 1, rm: "# JSON Schema Infer\\nAutomatically produces Zod and JSON Schema definitions from API samples.", ca: "2026-10-16T11:00:00Z", ua: "2026-11-04T16:00:00Z" },
  { name: "csv-to-sqlite", owner: "usr_marcusk", latest: "1.0.0", desc: "Ingests large CSV files into indexed SQLite databases with type guessing and batching.", lic: "Apache-2.0", repo: "https://github.com/marcus/csv-to-sqlite", cat: "data", kw: "[\"csv\",\"sqlite\",\"database\",\"etl\"]", comp: "[\"claude\",\"cursor\",\"antigravity\"]", dl: 2110, v: 0, rm: "# CSV to SQLite\\nTransforms massive flat files into queryable relational databases.", ca: "2026-10-18T15:00:00Z", ua: "2026-11-01T14:00:00Z" },
  { name: "prompt-optimizer", owner: "usr_sarahai", latest: "2.0.0", desc: "Analyzes system prompts, strips hallucinations triggers, adds few-shot examples, and trims tokens.", lic: "MIT", repo: "https://github.com/sarahchen/prompt-optimizer", cat: "research", kw: "[\"prompts\",\"few-shot\",\"llm\",\"tokens\"]", comp: "[\"claude\",\"openai\",\"antigravity\"]", dl: 4450, v: 1, rm: "# Prompt Optimizer\\nRefines agent prompts to maximize instruction adherence and reduce cost.", ca: "2026-10-20T10:00:00Z", ua: "2026-11-05T18:00:00Z" },
  { name: "python-type-annotator", owner: "usr_priyar", latest: "1.1.0", desc: "Adds strict Python 3.12 type annotations to untyped functions using mypy / pyright standards.", lic: "MIT", repo: "https://github.com/priyarao/python-type-annotator", cat: "coding", kw: "[\"python\",\"types\",\"mypy\",\"pyright\"]", comp: "[\"cursor\",\"codex\"]", dl: 2670, v: 1, rm: "# Python Type Annotator\\nAdds PEP 484 and PEP 604 type annotations to legacy Python code.", ca: "2026-10-22T13:00:00Z", ua: "2026-11-03T10:00:00Z" },
  { name: "test-case-synthesizer", owner: "usr_alexdev", latest: "1.2.0", desc: "Synthesizes edge-case test suites in Vitest, Jest, or Pytest from function signatures.", lic: "MIT", repo: "https://github.com/agent-skills/test-case-synthesizer", cat: "coding", kw: "[\"testing\",\"vitest\",\"jest\",\"pytest\",\"edge-cases\"]", comp: "[\"claude\",\"cursor\",\"codex\",\"antigravity\"]", dl: 3910, v: 1, rm: "# Test Case Synthesizer\\nGenerates thorough unit and boundary tests that maximize coverage.", ca: "2026-10-24T12:00:00Z", ua: "2026-11-05T12:00:00Z" }
];

const versionsMeta = [
  { name: "pdf-summarizer", owner: "usr_alexdev", version: "1.2.0", cat: "documents", desc: "Extracts text from PDF documents and generates structured agent summaries.", lic: "MIT", perm: { network: false, shell: false, filesystem: "read" }, pub: "2026-11-01T12:00:00Z" },
  { name: "pdf-summarizer", owner: "usr_alexdev", version: "1.1.0", cat: "documents", desc: "Extracts text from PDF documents and generates structured agent summaries.", lic: "MIT", perm: { network: false, shell: false, filesystem: "read" }, pub: "2026-10-15T09:30:00Z" },
  { name: "text-cleaner", owner: "usr_alexdev", version: "1.0.2", cat: "data", desc: "Fast text normalization, whitespace cleanup, and unicode sanitization for LLM context windows.", lic: "MIT", perm: { network: false, shell: false, filesystem: "none" }, pub: "2026-10-25T11:00:00Z" },
  { name: "git-commit-helper", owner: "usr_sarahai", version: "2.0.0", cat: "devtools", desc: "Generates conventional git commit messages and PR descriptions from staged diffs.", lic: "Apache-2.0", perm: { network: false, shell: true, filesystem: "read" }, pub: "2026-11-03T16:00:00Z" },
  { name: "sql-query-generator", owner: "usr_marcusk", version: "1.0.0", cat: "data", desc: "Translates natural language questions into safe, optimized SQL queries and explanations.", lic: "MIT", perm: { network: false, shell: false, filesystem: "none" }, pub: "2026-10-30T10:00:00Z" },
  { name: "web-page-extractor", owner: "usr_sarahai", version: "1.1.0", cat: "research", desc: "Safely fetches web pages, strips adverts and cookie modals, and outputs markdown for agents.", lic: "MIT", perm: { network: true, shell: false, filesystem: "none" }, pub: "2026-11-05T09:00:00Z" },
  { name: "code-refactorer", owner: "usr_priyar", version: "1.3.0", cat: "coding", desc: "Performs safe architectural refactoring, extracts functions, and removes code duplication.", lic: "Apache-2.0", perm: { network: false, shell: false, filesystem: "read-write" }, pub: "2026-11-02T15:00:00Z" },
  { name: "changelog-builder", owner: "usr_alexdev", version: "1.0.1", cat: "productivity", desc: "Analyzes git tags and commits to produce Markdown changelogs following Keep a Changelog.", lic: "MIT", perm: { network: false, shell: true, filesystem: "read-write" }, pub: "2026-10-28T14:00:00Z" },
  { name: "security-rule-auditor", owner: "usr_priyar", version: "2.1.0", cat: "devtools", desc: "Audits cloud security rules (Firestore, AWS IAM, Supabase) for privilege escalation risks.", lic: "MIT", perm: { network: false, shell: false, filesystem: "read" }, pub: "2026-11-04T12:00:00Z" },
  { name: "mermaid-diagram-generator", owner: "usr_marcusk", version: "1.0.0", cat: "documents", desc: "Transforms architectural descriptions and code into valid Mermaid flowcharts and sequence charts.", lic: "MIT", perm: { network: false, shell: false, filesystem: "write" }, pub: "2026-11-01T18:00:00Z" },
  { name: "regex-optimizer", owner: "usr_alexdev", version: "1.0.0", cat: "devtools", desc: "Synthesizes, tests, and explains high-performance regular expressions with catastrophic backtracking protection.", lic: "MIT", perm: { network: false, shell: false, filesystem: "none" }, pub: "2026-10-29T10:00:00Z" },
  { name: "api-mock-server", owner: "usr_sarahai", version: "1.2.0", cat: "devtools", desc: "Generates mock OpenAPI server stubs and synthetic fixtures from schemas for rapid frontend testing.", lic: "Apache-2.0", perm: { network: true, shell: true, filesystem: "none" }, pub: "2026-11-02T17:00:00Z" },
  { name: "markdown-formatter", owner: "usr_alexdev", version: "1.0.0", cat: "documents", desc: "Standardizes markdown tables, links, headers, and code fences according to CommonMark.", lic: "MIT", perm: { network: false, shell: false, filesystem: "read-write" }, pub: "2026-10-27T09:00:00Z" },
  { name: "dockerfile-linter", owner: "usr_marcusk", version: "1.1.0", cat: "devtools", desc: "Inspects Dockerfiles for root user risks, caching layer bloat, and secret leaks.", lic: "MIT", perm: { network: false, shell: false, filesystem: "read" }, pub: "2026-11-03T11:00:00Z" },
  { name: "slack-notifier", owner: "usr_sarahai", version: "1.0.0", cat: "communication", desc: "Sends agent progress summaries and alerts to Slack channels with interactive BlockKit formatting.", lic: "MIT", perm: { network: true, shell: false, filesystem: "none" }, pub: "2026-10-31T15:00:00Z" },
  { name: "jira-ticket-creator", owner: "usr_priyar", version: "1.0.0", cat: "productivity", desc: "Drafts comprehensive Jira bug tickets and feature requests from error logs and stack traces.", lic: "MIT", perm: { network: true, shell: false, filesystem: "none" }, pub: "2026-10-30T13:00:00Z" },
  { name: "json-schema-infer", owner: "usr_alexdev", version: "1.0.2", cat: "data", desc: "Infers strict JSON schemas and TypeScript interfaces from arbitrary sample JSON payloads.", lic: "MIT", perm: { network: false, shell: false, filesystem: "none" }, pub: "2026-11-04T16:00:00Z" },
  { name: "csv-to-sqlite", owner: "usr_marcusk", version: "1.0.0", cat: "data", desc: "Ingests large CSV files into indexed SQLite databases with type guessing and batching.", lic: "Apache-2.0", perm: { network: false, shell: false, filesystem: "read-write" }, pub: "2026-11-01T14:00:00Z" },
  { name: "prompt-optimizer", owner: "usr_sarahai", version: "2.0.0", cat: "research", desc: "Analyzes system prompts, strips hallucinations triggers, adds few-shot examples, and trims tokens.", lic: "MIT", perm: { network: false, shell: false, filesystem: "none" }, pub: "2026-11-05T18:00:00Z" },
  { name: "python-type-annotator", owner: "usr_priyar", version: "1.1.0", cat: "coding", desc: "Adds strict Python 3.12 type annotations to untyped functions using mypy / pyright standards.", lic: "MIT", perm: { network: false, shell: false, filesystem: "read-write" }, pub: "2026-11-03T10:00:00Z" },
  { name: "test-case-synthesizer", owner: "usr_alexdev", version: "1.2.0", cat: "coding", desc: "Synthesizes edge-case test suites in Vitest, Jest, or Pytest from function signatures.", lic: "MIT", perm: { network: false, shell: false, filesystem: "write" }, pub: "2026-11-05T12:00:00Z" }
];

const computedVersions = [];
for (const s of versionsMeta) {
  const manifest = {
    name: s.name,
    version: s.version,
    description: s.desc,
    license: s.lic,
    category: s.cat,
    compatibility: ["claude", "cursor"],
    permissions: s.perm
  };
  const skillMd = `---\nname: ${s.name}\ndescription: ${s.desc}\n---\n# ${s.name}\n\n${s.desc}`;
  const tgz = buildDeterministicTarGz([
    { path: "skill.json", content: JSON.stringify(manifest) },
    { path: "SKILL.md", content: skillMd }
  ]);
  const sha256 = crypto.createHash("sha256").update(tgz).digest("hex");
  computedVersions.push({
    id: `${s.name}@${s.version}`,
    skill_name: s.name,
    version: s.version,
    sha256,
    size: tgz.byteLength,
    tarball_path: `skills/${s.name}/${s.version}.tgz`,
    permissions: JSON.stringify(s.perm),
    published_by: s.owner,
    published_at: s.pub
  });
}

function generateSql(includeTokens) {
  let sql = `-- seed.sql: Realistic seed data for skillapt registry\n\n`;
  sql += `-- Users\nINSERT OR REPLACE INTO users (id, github_id, handle, name, email, avatar_url, role, created_at, updated_at) VALUES\n`;
  sql += `('usr_alexdev', 10101, 'alexdev', 'Alex Rivers', 'alex@example.com', 'https://avatars.githubusercontent.com/u/10101', 'user', '2026-08-01T10:00:00Z', '2026-11-01T10:00:00Z'),\n`;
  sql += `('usr_sarahai', 20202, 'sarahai', 'Sarah Chen', 'sarah@example.com', 'https://avatars.githubusercontent.com/u/20202', 'user', '2026-08-15T12:00:00Z', '2026-11-02T12:00:00Z'),\n`;
  sql += `('usr_marcusk', 30303, 'marcusk', 'Marcus Klein', 'marcus@example.com', 'https://avatars.githubusercontent.com/u/30303', 'user', '2026-09-01T09:00:00Z', '2026-11-03T09:00:00Z'),\n`;
  sql += `('usr_priyar', 40404, 'priyar', 'Priya Rao', 'priya@example.com', 'https://avatars.githubusercontent.com/u/40404', 'user', '2026-09-10T14:00:00Z', '2026-11-04T14:00:00Z');\n\n`;

  sql += `-- Skills (20 skills with latest_version initialized)\nINSERT OR REPLACE INTO skills (name, owner_id, latest_version, description, license, repository, category, keywords, compatibility, downloads, verified, readme, created_at, updated_at) VALUES\n`;
  const skillLines = skillsMeta.map(s => {
    return `('${s.name}', '${s.owner}', '${s.latest}', '${s.desc.replace(/'/g, "''")}', '${s.lic}', '${s.repo}', '${s.cat}', '${s.kw}', '${s.comp}', ${s.dl}, ${s.v}, '${s.rm.replace(/'/g, "''")}', '${s.ca}', '${s.ua}')`;
  });
  sql += skillLines.join(",\n") + ";\n\n";

  sql += `-- Versions for the skills with real SHA-256 sums\nINSERT OR REPLACE INTO skill_versions (id, skill_name, version, sha256, size, tarball_path, status, yanked, yank_reason, permissions, published_by, published_at) VALUES\n`;
  const verLines = computedVersions.map(v => {
    return `('${v.id}', '${v.skill_name}', '${v.version}', '${v.sha256}', ${v.size}, '${v.tarball_path}', 'active', 0, NULL, '${v.permissions.replace(/'/g, "''")}', '${v.published_by}', '${v.published_at}')`;
  });
  sql += verLines.join(",\n") + ";\n\n";

  sql += `-- Dependencies\nINSERT OR REPLACE INTO dependencies (id, skill_name, version, dep_name, dep_version_range) VALUES\n`;
  sql += `('dep_1', 'pdf-summarizer', '1.2.0', 'text-cleaner', '^1.0.0'),\n`;
  sql += `('dep_2', 'web-page-extractor', '1.1.0', 'text-cleaner', '^1.0.0'),\n`;
  sql += `('dep_3', 'test-case-synthesizer', '1.2.0', 'json-schema-infer', '^1.0.0');\n`;

  if (includeTokens) {
    sql += `\n-- Test fixture tokens (ONLY for tests/fixtures, never committed to migrations/)\n`;
    sql += `INSERT OR REPLACE INTO api_tokens (id, user_id, name, prefix, token_hash, last_used_at, created_at) VALUES\n`;
    sql += `('tok_demo_alex', 'usr_alexdev', 'cli-macbook', 'apt_live_test', 'e7dfad83081c4676824aa2472d46f28d603c447b614bd8adc264a12b420c4fdb', '2026-11-06T12:00:00Z', '2026-10-01T10:00:00Z');\n`;
  }

  return sql;
}

fs.mkdirSync(path.resolve("tests/fixtures"), { recursive: true });
fs.writeFileSync("migrations/seed.sql", generateSql(false), "utf8");
fs.writeFileSync("tests/fixtures/seed.sql", generateSql(true), "utf8");
console.log("Wrote migrations/seed.sql and tests/fixtures/seed.sql successfully!");
