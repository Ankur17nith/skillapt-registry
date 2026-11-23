# Discovery, ownership and agent-friendly search: plan

Goal: a registry that can hold ~1M skills on free tiers, where every skill has a
clear owner state, is filed under a category that says what it is for, and can be
found and installed by an LLM or agent using plain text.

## Principles
- **Index, don't host.** Crawled skills are metadata plus a link to the source
  (repo, path, commit SHA). Only directly published skills store tarballs in R2.
- **Ownership is explicit.** Every skill has `source` (`published` | `crawled`)
  and `claim_status` (`owned` | `unclaimed` | `claimed`). Crawled entries belong
  to a system user until the real repo owner claims them.
- **Plain text first.** Search, categories and skill pages have text/markdown
  forms so an agent needs no JSON parsing, and each ends with the install command.
- **Crawl outside the Worker.** Free Workers have 10 ms CPU per request, so the
  crawler runs as a scheduled GitHub Action and posts batches to an admin-only
  ingest endpoint (writes stay well under D1's 100k/day).

## Phases (each is a small commit series)
1. **Schema**: migration 0006 adds source/claim columns, a `skill_claims` table, a
   system `crawler` user and an FTS5 index for search.
2. **Taxonomy**: expand categories (what a skill is for) with labels and
   descriptions; `GET /v1/categories` with counts.
3. **Search**: FTS5 ranked search, `format=text`, `GET /v1/skills/:name` text form,
   `/llms.txt` and `/v1/llms.txt` on the registry.
4. **Ownership**: claim flow (`POST /v1/skills/:name/claim`), publish takeover of
   unclaimed crawled entries by the matching scope owner, audit log.
5. **Ingest + crawler**: `POST /v1/admin/ingest` (batched, idempotent) and
   `scripts/crawl-github.mjs` run by a cron workflow. Respects licenses; stores
   metadata only; honours an opt-out file.
6. **Web**: category browse and filters, ownership badges, `llms.txt`/`llms-full.txt`,
   JSON-LD, layout alignment fixes.
7. **CLI**: `search --category/--format text`, `categories`, claim hint, and a
   `skillapt mcp` stdio server (`search_skills`, `get_skill`, `install_skill`).
8. **npm**: publish `skillapt` with provenance; verify the name is free first.

## Out of scope / needs a human
- Running `wrangler deploy`, creating the D1 database, and `npm publish` (these use
  your accounts).
- Free-tier limits change; at 1M skills with real traffic a paid plan may be needed.
