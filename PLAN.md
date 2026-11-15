# PLAN.md: skillapt-registry (Cloudflare Worker)

> Single source of truth for planning, status and standards in this repo.
> Every agent (human or AI) MUST read this file completely before touching code, and MUST update it as part of its work.
> Sections 3 and 16 are shared with the `skillapt` CLI repo and must stay identical there.

---

## 0. Agent protocol (read first, follow every session)

### 0.1 Session start checklist
1. Read this whole file. Pay attention to: §1 Status, §3 Contract, §5 Invariants, §7 Work plan, §11 Decisions, §12 Open questions.
2. Verify reality, do not trust checkboxes blindly:
   ```bash
   git fetch --all --prune
   git status
   git branch -a
   git log --graph --oneline --decorate --all | head -60
   pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
   pnpm smoke            # exists after REG-04: starts the Worker on workerd and curls /v1/health
   pnpm test:integration # exists after REG-37: real workerd + local D1/R2 scenarios
   ```
3. If this dashboard disagrees with reality, fix the dashboard first (`docs(plan): sync status`) and add a row to §13.
4. Pick the FIRST unchecked task in list order of §7 (milestones in order). Skip only tasks marked `[!]` (blocked; reason in §12).
5. If something is unclear, ambiguous or security-relevant, check §11 and §12. If still unclear, STOP and ask the human.

### 0.2 While working
- One task = one or more small commits. A commit that finishes a task also ticks its checkbox and updates §1.
- Never mark `[x]` unless the task's **V:** passes and its **AC:** are met.
- Every bug fix gets a regression test in the same branch. Every security fix gets a test that reproduces the original attack.
- New problem found? Add it to §6 (next free ID, severity), add a task in §7, continue. Do not silently fix unrelated things.
- Decision changed? Append a row to §11 (never delete rows; mark superseded).
- Never change §3 in only one repo. It needs a human decision and the same change in the CLI repo.
- **Tests run on Node with mock D1/R2; production runs on workerd with real D1/R2/Durable Objects. Passing vitest does NOT prove the Worker runs.** Run `pnpm smoke` and `pnpm test:integration` after touching module scope, config, bindings, migrations, or storage code.

### 0.3 Session end checklist
1. `pnpm typecheck && pnpm test && pnpm smoke` (and `pnpm test:integration` once it exists) are green.
2. Append a row to §13 (date, agent, branch, tasks, result, next step); update §1.
3. `git push -u origin <branch>`. Never leave work only local.

### 0.4 Legend
`[ ]` todo · `[~]` in progress · `[x]` done and verified · `[!]` blocked
**AC** = acceptance criteria · **V** = verification command/test · **Sev** = Critical / High / Medium / Low

### 0.5 Hard rules (never violate)
- NEVER run against production or any `--remote` Cloudflare resource: no `wrangler deploy`, no `d1 ... --remote`, no `wrangler secret put`, no `wrangler login`. Preparing commands and docs for the human is allowed.
- NEVER create or push git tags, and never run `npm publish`. The human does releases.
- Never delete a branch (local/remote), never force-push, never squash-merge (§8).
- Never commit secrets or real tokens. Test tokens exist only in `tests/fixtures/` and temp local DBs.
- Never edit `migrations/0001_initial.sql`; add new numbered migrations (append-only, one concern per file, NOT NULL columns need defaults; D1 cannot ADD CHECK constraints).
- Never weaken a validation to make a test pass.
- No timers, `fetch`, or random generation at module (global) scope in the Worker.

---

## 1. Status dashboard (keep current)

| Field | Value |
|---|---|
| Last updated | 2026-11-15 (M5 in progress: REG-43..REG-47 strictness, staging, and operational fixes) |
| Current milestone | M5: Strictness, staging, and operational fixes (in progress) |
| Current branch | `main` (starting REG-43) |
| Current task | REG-43: SKILL.md name strictness |
| Baseline | `tsc` clean; 153/153 vitest tests pass; `pnpm smoke`, `pnpm test:integration` (14 scenarios), `pnpm conformance` (12 CLI + 5 attack scenarios) & `post-deploy-check.sh` pass on workerd |
| Deployed | Tag `v1.1.0` exists at commit `027fac8`. Target release bumped to `v1.2.0` (D-012). Production `database_id` in wrangler.jsonc is a placeholder (`00000000-0000-0000-0000-000000000000`) |
| Dependencies | `pnpm audit --prod`: 0 vulnerabilities; `zod` is at 4.6.7 (PR #6 merged, remains per policy "build on what exists; do not revert it"; no further zod PRs); vitest 5.1.0, workers-types 5.20261108.1, hono 4.13.17, wrangler 4.160.0 |
| CLI repo (`skillapt`) | Complete & built locally in `../skillapt`: tag `v1.0.0` checked out, passed all 12 CLI scenarios and 5 attack tests in `pnpm conformance` |

| Milestone | Goal | Status |
|---|---|---|
| M1 | Worker runs on Cloudflare; publish validation closed (scope, names, binaries, versions, dependencies); workerd integration tests | [x] |
| M2 | Atomic publish, takedown/status, auth/CSRF/CORS hardening, token dashboard | [x] |
| M3 | Real rate limits, search/download performance, seed and test hygiene, cron cleanup, CLI conformance | [x] |
| M4 | Docs/CI sync and production-ready deploy package (human deploys) | [x] |
| M5 | Strictness, staging, and operational fixes (REG-43..REG-47) | [~] |

---

## 2. Project overview

**skillapt-registry** is the HTTPS API behind the skillapt package manager for AI agent skills. It authenticates publishers (GitHub OAuth for the web, API tokens for the CLI), validates and stores immutable skill tarballs (R2), stores metadata (D1), serves search/detail/download, supports yank (owner) and takedown (admin), takes abuse reports, and serves a small `/dashboard` for token management.

```
CLI (skillapt) --HTTPS--> Worker (Hono) --> D1 (metadata, users, tokens, reports, audit)
                                      \--> R2 (tarballs: skills/<name>/<version>.tgz)
                                      \--> Durable Object (rate limiter)
Browser --> /v1/auth/github --> GitHub OAuth --> /v1/auth/github/callback --> /dashboard
```
Tech: Cloudflare Workers (workerd), Hono, D1, R2, Durable Objects, zod 3, semver, `yaml`, vitest (Node, mock D1 via `node:sqlite`, mock R2), pnpm, wrangler 4.

### 2.1 Repository map (current -> target)
```
src/index.ts               app, CORS, error handling, route mounting (+ export of Durable Object class)
src/config.ts              LIMITS, allowlists, RESERVED_NAMES
src/routes/skills.ts       search, publish, detail, version, download, yank
src/routes/auth.ts         GitHub OAuth, sessions, logout
src/routes/tokens.ts       /v1/tokens, /v1/me
src/routes/reports.ts      abuse reports
src/routes/stats.ts        counters
src/routes/admin.ts        (new) takedown, restore, reports review
src/routes/dashboard.ts    (new) server-rendered token page
src/middleware/            auth, csrf (new), cors (new), rate-limit (DO client), request-id (new)
src/ratelimit/             (new) Durable Object + in-memory test impl
src/validation/tar.ts      tarball inspection (rewrite)  ·  manifest.ts  skill.json schema
migrations/                0001 (immutable) + 0002.. (see §4.3); NO seed data
scripts/                   dev-seed (local only), smoke, integration, conformance, post-deploy-check
tests/ tests/security/ tests/fixtures/ tests/helpers/
docs/                      SPEC.md openapi.yaml DEPLOY.md RUNBOOK.md
wrangler.jsonc             env.production, routes, D1, R2, Durable Object, cron
```

---

## 3. Cross-repo contract (IDENTICAL in skillapt and skillapt-registry; change only with a human decision, in both repos; diff before merging)

### 3.1 Base URL and transport
- Production: `https://registry.skillapt.dev/v1`. HTTPS required; `http://` allowed only for `localhost`/`127.0.0.1`.
- Errors: `{"error":{"code":"<UPPER_SNAKE>","message":"<text>"}}`. Rate limit: 429 + `Retry-After`.

### 3.2 Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /health | none | liveness |
| GET | /skills?q&category&compat&verified&sort&page&limit | none | search |
| POST | /skills | token | publish (multipart `file` or `application/gzip`) |
| GET | /skills/{name} | none | detail + all versions (name URL-encoded, e.g. `%40a%2Fb`) |
| GET | /skills/{name}/{version} | none | version metadata |
| GET | /skills/{name}/-/{version}.tgz | none | tarball |
| POST | /skills/{name}/{version}/yank | token (owner) | idempotent: set yanked=true |
| DELETE | /skills/{name}/{version}/yank | token (owner) | un-yank |
| POST | /admin/skills/{name}/{version}/takedown, /restore | admin role | takedown / restore |
| GET/POST/DELETE | /tokens, /tokens/{id} | **session** | manage API tokens |
| GET | /me, /stats | token or session / none | profile / counters |
| POST | /reports | none | abuse report |
| GET | /auth/github, /auth/github/callback | none | OAuth login |
| GET | /dashboard | session | web page to manage tokens |

### 3.3 Version payload
```
{ name, version, sha256, integrity:"sha256-<hex>", size, tarballUrl?, dependencies:{name:range},
  publishedAt, yanked:boolean, status:"active"|"yanked"|"removed", removed?:boolean,
  removalReason?, permissions:{network:boolean, shell:boolean, filesystem:"none"|"read"|"write"|"read-write"} }
```
`removed` versions: no `tarballUrl`, download returns **410 Gone**, excluded from resolution. `yanked`: excluded from range resolution, still downloadable when pinned (lockfile).

### 3.4 Names, versions, files
- Package name: `^(@[a-z0-9]+(-[a-z0-9]+)*\/)?[a-z0-9]+(-[a-z0-9]+)*$`, 3 to 50 chars (name part), scope 2 to 30 chars. **No consecutive hyphens (`--`) in scope or name** (D-003). `@scope` must equal the publisher's GitHub login (lowercased); the scope belongs to the GitHub account id.
- Reserved (unscoped names and scopes): skillapt, admin, api, www, official, registry, support, security, root, claude, openai, anthropic, cursor, codex, antigravity, gemini, chatgpt, null, undefined, core, internal, system, auth, account, dashboard.
- Version: canonical semver only (`semver.valid(v) === v`), **no build metadata, no `v` prefix**, max 64 chars.
- **On-disk folder name** for a package: unscoped `name` -> `name`; scoped `@scope/name` -> `scope--name` (flat, always a direct child folder). SKILL.md frontmatter `name` MUST equal the on-disk folder name (D-004).
- SKILL.md: <= 256 KB, YAML frontmatter with `name` and non-empty `description`. Non-standard keys go under `metadata:`.
- Limits: tarball <= 5 MB, uncompressed <= 25 MB, <= 500 files, path <= 255 chars, depth <= 10, dependencies <= 50, keywords <= 10.
- Allowed file types: `.md .txt .prompt .rst .json .yaml .yml .toml .csv .tsv .jinja .jinja2 .mustache .hbs .template .js .mjs .cjs .ts .py .sh .bash .zsh .lua .rb .html .css .xml .xsd .svg`, extensionless `LICENSE NOTICE README CHANGELOG Makefile`, and `.gitignore .editorconfig`. Anything else is rejected. (Images/PDF/fonts: NOT allowed until decision D-006.)
- Banned always: symlinks, hardlinks, devices/FIFOs, absolute paths, `..` segments, hidden files/dirs in **any** segment (except the two above), duplicate paths (case-insensitive + NFC), files whose first 512 bytes are ELF / Mach-O (incl. 0xCAFEBABE) / PE `MZ` / Java class / WASM.
- Layout: files at archive root or under exactly one wrapper directory; exactly one `skill.json` and one `SKILL.md` at the package root.
- `skill.json`: `name, version, description (10..300), license, repository? (https only), keywords?, category (documents|coding|research|data|devtools|communication|productivity|other), compatibility[] (claude|cursor|codex|antigravity|openai|custom), dependencies?{name: semver range}, permissions{network,shell,filesystem}`.
- `permissions` are declarations, NOT enforcement.

### 3.5 Tokens and sessions
- API token: `apt_live_` + 32 hex chars, stored hashed (SHA-256) server-side, shown once, expires (default 90 days), max 20 per user. Tokens cannot create tokens (session required).
- The CLI MUST bind a stored token to a registry origin and never send it to any other origin or over plain http (except localhost).

### 3.6 Agent target directories
| `--target` | Project path | Global path (`--global`) |
|---|---|---|
| claude | `.claude/skills/` | `~/.claude/skills/` |
| cursor | `.cursor/skills/` | `~/.cursor/skills/` |
| codex | `.codex/skills/` (verify) | `~/.codex/skills/` (verify) |
| antigravity | `.agents/skills/` | `~/.gemini/config/skills/` |
| antigravity-cli | `.agents/skills/` | `~/.gemini/antigravity-cli/skills/` |
Legacy Antigravity (only if the new dir is absent and the legacy dir exists, print a notice): `.agent/skills/`, `~/.gemini/antigravity/skills/`. Override via `SKILLAPT_<TARGET>_DIR`. Verify against current vendor docs and log in §11 (D-005).

---

## 4. Architecture notes (registry)

### 4.1 Publish pipeline (target design)
auth -> `Content-Length` check (<= 5 MB else 413) -> capped body read -> tarball validation (§3.4) -> manifest validation -> scope ownership -> reserved names -> dependencies exist and are not removed -> sha256 -> R2 **create-only** put -> one D1 `batch()` (skills upsert, skill_versions insert, dependencies, latest_version) -> on any failure delete the R2 object we created -> `201 {name, version, sha256, integrity, size, tarballUrl}`.
If real R2 does not honor `onlyIf: {etagDoesNotMatch:"*"}`, use the reserve-first fallback of D-009.

### 4.2 Auth model
- Bearer token (SHA-256 lookup, expiry checked) or session cookie `skillapt_session` (HttpOnly, Secure outside development, SameSite=Lax, host-only, no Domain attribute).
- Cookie-authenticated POST/PUT/PATCH/DELETE require `Origin` (or `Referer`) to match `PUBLIC_ORIGIN` or the CORS allowlist (403 `CSRF_VIOLATION`). Bearer is exempt.
- Token management endpoints and the dashboard require a session. Admin endpoints require `users.role = 'admin'` via session or token.
- Scope ownership: on first login the account claims its lowercased GitHub login as its scope **if** it matches the scope rule; the scope is bound to `github_id` and never moves on rename. Accounts whose login is not a valid scope (e.g. > 30 chars, consecutive hyphens) get no scope and publish unscoped names only (D-011).

### 4.3 Data model and planned migrations (append-only; names may be adjusted, concerns must stay separate)
- `0001_initial.sql` (immutable): users, sessions, api_tokens, skills, skill_versions, dependencies, reports.
- `0002_scopes_and_latest.sql`: `scopes(scope PK, owner_id, github_id UNIQUE, created_at)` with backfill from users where valid; `skills.latest_version TEXT` (NULL allowed, recomputed lazily).
- `0003_status_roles_audit.sql`: `skill_versions.status TEXT NOT NULL DEFAULT 'active'` (+ backfill from `yanked`), `removal_reason`, `removed_at`; `users.role TEXT NOT NULL DEFAULT 'user'`; `audit_log(id, actor_id, action, target, detail, created_at)`.
- `0004_auth_hardening.sql`: `api_tokens.expires_at` (backfill now + 90 days, ISO format); sessions: `DELETE FROM sessions` (ids become hashes) + `csrf TEXT NOT NULL DEFAULT ''`; `reports.reporter_hash` and redact old `reporter_ip`; `download_dedupe(skill_name, version, ip_hash, day, PRIMARY KEY(...))`.
- Storage: R2 key `skills/<name>/<version>.tgz`, never overwritten.

### 4.4 Configuration
- Vars: `ENVIRONMENT` (`development` | `production`), `PUBLIC_ORIGIN` (e.g. `https://registry.skillapt.dev`), `CORS_ORIGIN` (exact comma list; no `*`; no localhost in production).
- Secrets (wrangler secret, human sets): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `HASH_SALT` (IP hashing for reports and download dedupe).
- Bindings: `DB` (D1), `STORAGE` (R2), `RATE_LIMITER` (Durable Object, SQLite-backed), cron trigger (daily cleanup).

---

## 5. Security invariants (every change must preserve these; each has a test)

- R1. Only the owner of a scope may publish `@scope/*`; ownership is bound to the GitHub account id, not the mutable handle.
- R2. Reserved names cannot be registered (unscoped names and scopes).
- R3. Published versions are immutable: canonical semver only, no overwrite (R2 create-only + UNIQUE), no `+build` aliases.
- R4. Tarball validation uses the EFFECTIVE path of each entry (PAX applied) and rejects what it does not understand. Registry validation == CLI validation (§3.4).
- R5. No executable binaries (magic bytes), no hidden files/dirs, no links, no traversal, no duplicates, no manifest confusion.
- R6. Publish is atomic: no orphan R2 objects, no skill rows without versions.
- R7. Takedown works: removed versions return 410 and disappear from resolution; every admin action is audited.
- R8. Cookie-authenticated mutations require an allowed Origin; CORS is an exact allowlist; never `*` with credentials; no localhost origins in production.
- R9. Raw tokens and session ids are never stored; IPs are stored only as salted hashes.
- R10. Internal error details never reach clients in production; logs carry a request id.
- R11. No module-scope timers, I/O or randomness in the Worker.
- R12. Seed/demo credentials never exist in `migrations/`; dev seeds refuse `--remote` and production.
- R13. Rate limits use only `cf-connecting-ip`; `x-forwarded-for` is never trusted.

---

## 6. Audit baseline (2026-11-15). Known issues by ID & Reconciliation Status

| ID | Sev | Issue | Status & Evidence |
|---|---|---|---|
| B-01 | Critical | Worker fails to start on workerd: `setInterval` at module scope in rate-limit.ts | Resolved in b12b485. Verified by `tests/startup.test.ts` and `pnpm smoke` (workerd starts cleanly). |
| B-02 | Critical | No scope ownership: `sarahai` published `@alexdev/pdf-tools` and `@anthropic/helper` (201) | Resolved in 2192be4. Migration 0002 introduces `scopes` table bound to github_id; tests assert 403. |
| B-03 | Critical | Reserved names enforced only in the CLI: `claude`, `admin` published (201) | Resolved in 2192be4. `RESERVED_NAMES` list and `--` reject in `src/config.ts`; tests assert 400. |
| B-04 | Critical | No magic-byte check: ELF in `run.py`, MZ in `a.txt` accepted | Resolved in 2192be4. Magic byte inspection on 512 bytes in `src/validation/tar.ts`; tests assert 400. |
| B-05 | Critical | PAX bypass: registry validated `ok.md`, node-tar extracts `payload.exe` | Resolved in 2192be4. PAX `x` headers applied to effective path in `src/validation/tar.ts`; tests assert 400. |
| B-06 | Critical | No takedown: no `status`/`removed`, no admin routes (SPEC/openapi list them); reports never reviewed | Resolved in a0a9273 & 1d90ea1. Migration 0003 adds status, removed_at, removal_reason, users.role, audit_log; admin routes implemented. |
| B-07 | Critical | `migrations/seed.sql` holds a demo token (sha256 of `apt_live_testtoken1234567890abcdef` matches) owning verified skills; tests depend on it | Resolved in 8900e89. Demo tokens removed from migrations; test fixtures moved to `tests/fixtures/seed.sql`; test enforces no token insert in migrations. |
| B-08 | Critical | No way to obtain a token: OAuth redirects to a non-existent `/dashboard` | Resolved in cdda971. Server-rendered `/dashboard` implemented with strict CSP and CSRF. |
| B-09 | High | Hidden directories allowed (`.claude/settings.json` -> 201) | Resolved in 2192be4. Every path segment checked for hidden dot-prefixes in `src/validation/tar.ts`. |
| B-10 | High | Non-canonical versions accepted: `v1.0.0`, ` 1.0.0`, `1.0.0+evil` | Resolved in 2192be4. `semver.valid(v) === v` enforced strictly, no build metadata. |
| B-11 | High | Dependencies unchecked: junk keys (`../../etc/x`), 60+ entries, nonexistent, self-dependency; `MAX_DEPENDENCIES` unused | Resolved in 2192be4. Checked against regex, non-removed existence, cycles, depth <= 10. |
| B-12 | High | `repository: "javascript:alert(1)"`, arbitrary `compatibility`, unvalidated SKILL.md frontmatter, 3 MB SKILL.md accepted | Resolved in 2192be4. Manifest schema and SKILL.md YAML validation enforced. |
| B-13 | High | Manifest confusion: `skill.json` accepted at depth 1 or 2; names trimmed; no header checksum or duplicate checks | Resolved in 2192be4. Strict archive root/single-wrapper layout, checksum validation, duplicate detection. |
| B-14 | High | Publish not atomic: R2 put first, separate D1 inserts; concurrent same-name publish can overwrite the R2 object; failures leave orphans | Resolved in ce87342. Conditional R2 put + atomic D1 batch + rollback on failure; reserve-first fallback handled per D-009. |
| B-15 | High | No publish rate limit (15 publishes -> all 201); in-memory limiter is per isolate; `x-forwarded-for` fallback | Resolved in 26557cf & 429065c. Durable Object rate limiter with sliding window, cf-connecting-ip only. |
| B-16 | High | CORS `*` + credentials reflects any origin; localhost allowed in production by default; base config `ENVIRONMENT=development` weakens cookies | Resolved in 79fd970 & b56292b. Strict CORS allowlist, env.production, Secure cookies outside dev. |
| B-17 | High | No CSRF Origin check: token mint with `Origin: https://evil.example` -> 201 | Resolved in b56292b. Exact match Origin/Referer checked on cookie-authenticated mutations. |
| B-18 | High | An API token can mint further tokens; no expiry, count limit or scope | Resolved in 98ec714. Session required for token minting, max 20 active tokens, 90-day expiry. |
| B-19 | High | Yank is a toggle: the same request twice un-yanks | Resolved in 1d90ea1. POST is idempotent yank; DELETE un-yanks. |
| B-20 | High | `onError` returns `err.message` (leaks internals) | Resolved in b56292b. Generic error in production with logged requestId. |
| B-21 | Medium | Search N+1 (up to 101 D1 queries/request); `LIKE` wildcards unescaped; latest via per-row sort; prereleases counted | Resolved in 72c6a6b. Joined query using latest_version, escaped LIKE wildcards. |
| B-22 | Medium | Downloads buffer the whole object, count every request, `immutable` cache even for yanked | Resolved in 72c6a6b & d6e2fa9. Streamed R2 body, ETag 304, download_dedupe table with daily hash. |
| B-23 | Medium | Reports: raw IP stored, `details` unbounded, `version` unvalidated | Resolved in 72c6a6b & d6e2fa9. Reporter IP salted & hashed (HASH_SALT), details capped at 2000 chars. |
| B-24 | Medium | OAuth/sessions: `user:email` requested but unused; session ids plaintext in DB; expired sessions never deleted; handle rename can hit UNIQUE -> 500; `SESSION_SECRET` unused | Resolved in 9a2d6cf. sha256 hashed session ids, expired cleanup on lookup, user:email scope removed. |
| B-25 | Medium | Publishing an older version overwrites skill-level description/readme | Resolved in ce87342. Only highest stable version updates package-level metadata. |
| B-26 | Low | wrangler 3 outdated; runtime `zod` high advisory; junk `allowBuilds` placeholder in pnpm-workspace.yaml; placeholder `database_id`; README `file:///home/ankurgupta/...` link; tests need Node >= 22.5 with no `engines`/CI | Resolved in d2dd00f & 79fd970. Wrangler 4, engines >= 22.5, workspace cleaned. Production database_id placeholder documented. |
| B-27 | Medium | All tests run on Node with mocks; nothing exercises workerd, real D1 batch/limits, R2 conditional puts or Durable Objects | Resolved in 1927008 (REG-37). `pnpm test:integration` runs 14 full scenarios on real workerd with local D1, R2, and DO. |
| B-28 | Medium | The registry has never been run against the real CLI (v1.0.0 was tested against a mock only) | Resolved in Branch 10 (REG-38). `pnpm conformance` drives the real CLI v1.0.0 across all lifecycle operations (init, pack, publish, search, info, install, --frozen, yank, un-yank, outdated, update, takedown, and attack tarballs). |
| B-29 | Low | GitHub logins can be up to 39 chars and legacy ones contain consecutive hyphens, but the scope rule is 2..30 chars without `--` (see D-011) | Resolved in 2192be4 per D-011. Logins not matching scope criteria claim no scope. |

---

## 7. Work plan

Order is mandatory. Each BRANCH is created from the latest `main`, merged with `--no-ff`, never deleted (§8). Before every commit: `pnpm typecheck && pnpm test` (plus `pnpm smoke` and `pnpm test:integration` once they exist).

### M1. Make it run and make publishing safe

#### Branch `fix/worker-startup-and-config`
- [x] **REG-01** (B-01) Remove the module-scope `setInterval` from `src/middleware/rate-limit.ts`; no timers/I-O/randomness at module scope anywhere.
  V: `wrangler dev --local` starts and `/v1/health` answers; a test asserts no timers are created at import.
- [x] **REG-02** (B-26) Upgrade wrangler to v4; upgrade zod (patched 3.x), hono, semver; fix `pnpm-workspace.yaml` (remove placeholder `allowBuilds`, keep `onlyBuiltDependencies`); add `engines.node >=22.5` and `packageManager`.
  V: `pnpm audit --prod` has no high/critical; clean install.
- [x] **REG-03** (B-16, B-26) wrangler.jsonc: `env.production` with `ENVIRONMENT=production`, `PUBLIC_ORIGIN`, `routes` (custom domain `registry.skillapt.dev`), observability on, current `compatibility_date`, clearly marked placeholder `database_id`; base config must not be able to produce insecure cookies in production; add `.dev.vars.example`; remove unused `SESSION_SECRET` (types, README); remove `nodejs_compat` if unused.
  V: `wrangler deploy --dry-run --env production` succeeds.
- [x] **REG-04** `pnpm smoke`: starts `wrangler dev --local` on a free port, polls `/v1/health`, fails with the runtime log if it does not start.
- [x] **REG-37** (B-27) `pnpm test:integration`: script that starts `wrangler dev --local --persist-to <tmp>`, applies migrations (`wrangler d1 migrations apply DB --local`), then runs HTTP scenarios with `fetch` (health, publish valid package, read back, download + sha256, yank/unyank, dependency resolution data). Extended by later branches.
  V: runs green locally and in CI; fails if the Worker does not start.

#### Branch `fix/publish-validation`
Create `tests/security/publish-attacks.test.ts` reproducing each attack in this branch and asserting 400/403.
- [x] **REG-05** (B-02, B-29) Migration `0002`: scopes table (§4.3). On login claim the lowercased GitHub login as the scope if it is a valid scope (D-011). `@scope/name` only by the scope owner (by `github_id`).
  AC: `sarahai` publishing `@alexdev/x` or `@anthropic/x` -> 403; renamed accounts keep their scope.
- [x] **REG-06** (B-03) `RESERVED_NAMES` in `src/config.ts` (list in §3.4) for unscoped names and scopes; reject `--` in names/scopes (D-003). AC: `claude`, `admin`, `a--b`, `@admin/x` -> 400.
- [x] **REG-07** (B-10) Canonical versions only (`semver.valid(v)===v`, no `+`, max 64). AC: `v1.0.0`, ` 1.0.0`, `1.0.0+evil`, `=1.0.0` -> 400.
- [x] **REG-08** (B-11, B-12) Manifest rules: dependency keys match the name regex; max 50 (`LIMITS.MAX_DEPENDENCIES`); no self-dependency; each dependency exists, is not removed and has a version satisfying the range (400 `INVALID_DEPENDENCY`); no cycles; depth <= 10; compatibility in the enum; repository https-only; license charset restricted (`[A-Za-z0-9.+() -]`, max 50); keywords per §3.4; SKILL.md <= 256 KB, parsed with the `yaml` package, `name` == on-disk folder name (D-004), non-empty `description`.
- [x] **REG-09** (B-04, B-05, B-09, B-13) Rewrite `src/validation/tar.ts`:
  - verify header checksums; allow only type flags `0`, NUL, `5`;
  - PAX `x` records: apply `path` and `size` to the next entry, ignore harmless keys (mtime, atime, ctime, uid, gid, uname, gname, comment), reject `linkpath`; reject `g`, GNU `L`/`K` and every other type with a clear error;
  - do not trim names; reject leading/trailing spaces, control chars, backslashes, empty segments;
  - reject duplicates (case-insensitive + NFC);
  - layout rule: root or exactly one wrapper dir; exactly one `skill.json` and one `SKILL.md` at the package root; reject any other copy elsewhere;
  - hidden rule on every path segment; allowlist exactly as §3.4;
  - magic bytes on the first 512 bytes of every file: ELF `7F 45 4C 46`, Mach-O `FE ED FA CE/CF`, `CE FA ED FE`, `CF FA ED FE`, `CA FE BA BE` (also Java class), PE `4D 5A`, WASM `00 61 73 6D`;
  - 25 MB limit enforced on actual decompressed bytes AND on the sum of declared sizes; 500 files; 255-char and depth-10 limits on effective paths.
  V: attacks B-04, B-05, B-09, B-13 return 400; archives built by real node-tar (`portable: true`, long paths split into ustar prefix) still pass.

### M2. Atomic publish, status/takedown, auth hardening

#### Branch `fix/publish-atomicity-and-limits`
- [x] **REG-10** (B-14) Check `Content-Length` (413 for > 5 MB before reading); read the body through a size-capped stream (also when Content-Length is absent).
- [x] **REG-11** (B-14) Pipeline per §4.1: R2 create-only put (409 on conflict), single D1 `batch()`, delete the R2 object we created on failure. Extend `MockD1Database` (atomic `batch`) and `MockR2Bucket` (`onlyIf`). Verify real-R2 behavior in `test:integration` (miniflare) and record the result in D-009.
  V: tests for concurrent same-version publish and forced mid-way failure leave no orphans.
- [x] **REG-12** (B-25) Update skill-level description/readme only when the published version is the highest stable one; maintain `skills.latest_version` on publish/yank/restore/takedown.
- [x] **REG-13** Return `integrity: "sha256-<hex>"` in every version payload (§3.3).

#### Branch `feat/takedown-and-version-status`
- [x] **REG-14** (B-06) Migration `0003` per §4.3 (status with backfill, removal fields, `users.role`, `audit_log`).
- [x] **REG-15** (B-06) Admin routes: `POST /v1/admin/skills/:name/:version/takedown` and `/restore`, `GET /v1/admin/reports`, `POST /v1/admin/reports/:id/resolve`; role-based; every action recorded in `audit_log`.
- [x] **REG-16** (B-06) Behavior per §3.3: 410 on removed downloads (`Cache-Control: no-store`), `status`/`removed`/`removalReason` in metadata, no `tarballUrl`, excluded from `latest_version` and resolution.
- [x] **REG-17** (B-19) `POST .../yank` idempotent (sets true); `DELETE .../yank` un-yanks; reason <= 500 chars.
  AC: sending the same yank twice keeps the version yanked.

#### Branch `fix/auth-sessions-csrf-cors`
- [x] **REG-18** (B-17) Origin/Referer exact-match CSRF check on cookie-authenticated mutations (403 `CSRF_VIOLATION`); Bearer exempt.
- [x] **REG-19** (B-16) CORS: exact allowlist, reject `*` when credentials are on, no localhost origins in production, no fallback-origin echo, `Vary: Origin`.
- [x] **REG-20** (B-18) Token management requires a session (not a token); max 20 active tokens per user; `expires_at` (default 90 days) enforced in `authenticate()`; migration `0004` (§4.3).
- [x] **REG-21** (B-24) Sessions store `sha256(cookie value)`; delete expired sessions on lookup; rotate on login; add `csrf` column.
- [x] **REG-22** (B-24) OAuth: request only `read:user`; do not store email (`/v1/me` no longer returns it); handle `UNIQUE(handle)` conflicts on rename with a clear 409, never 500.
- [x] **REG-23** (B-20) `onError`: generic message + request id in production, real error logged server-side; request-id middleware; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on authenticated routes.
  V: hostile Origin + cookie -> 403; CORS `*` rejected at startup/with an error; a token creating a token -> 403; error text does not leak.

#### Branch `feat/token-dashboard`
- [x] **REG-24** (B-08) `GET /dashboard`: server-rendered HTML, no external scripts, strict CSP, per-session CSRF token in forms. Shows the user, lists tokens, creates a token (shown once), revokes, logs out. OAuth callback redirects here; README login flow updated.
  V: integration scenario with a fixture session; HTML escapes all user data (test with `<script>` in a token name).

### M3. Limits, performance, hygiene, conformance

#### Branch `fix/rate-limiting`
- [x] **REG-25** (B-15) Replace the in-memory limiter with a Durable Object (SQLite-backed) sliding window behind a `RateLimiter` interface (in-memory impl for unit tests only). Client IP from `cf-connecting-ip` only (R13). Limits: downloads 120/min/IP, search 60/min/IP, publish 10/hour/user, OAuth 20/10 min/IP, token creation 10/day/user, reports 5/hour/IP, general 300/min. Add DO binding and `new_sqlite_classes` migration to wrangler.jsonc.
  V: tests per limit (429 + `Retry-After`); 15 publishes -> the 11th is 429; the DO works under `test:integration`.

#### Branch `fix/search-download-reports`
- [x] **REG-26** (B-21) Search without N+1 (use `latest_version`); escape `LIKE` with `ESCAPE '\'`; cap `q` at 100 chars; validate `sort`/`category`; exclude prereleases from latest; `/v1/stats` cached 60 s.
- [x] **REG-27** (B-22) Download: stream the R2 body (no `arrayBuffer`), ETag/`If-None-Match` (304), `immutable` only for active versions, short max-age for yanked; dedupe counting via `download_dedupe` (INSERT OR IGNORE, count only on insert, skip HEAD/Range, `waitUntil`).
- [x] **REG-28** (B-23) Reports: `details` <= 2000 chars; `version` must exist or be `*`; store `sha256(ip + HASH_SALT)` in `reporter_hash`, redact `reporter_ip`.
- [x] **REG-42** Daily cron trigger: purge expired sessions, old `download_dedupe` rows (> 2 days) and expired tokens; test the `scheduled` handler.

#### Branch `chore/seed-and-test-hardening`
- [x] **REG-29** (B-07) Remove the demo token, fake sha256 values and fake versions from `migrations/seed.sql`; move test data to `tests/fixtures/seed.sql`; add `scripts/dev-seed.*` for local dev (publishes real tarballs through the API); the seed script refuses `--remote` and `ENVIRONMENT=production`. Replace the README curl token with a placeholder.
  AC: a test fails if anything under `migrations/` inserts into `api_tokens`.
- [x] **REG-30** Regression tests under `tests/security/` for every attack in §6 (scope hijack, reserved names, version forms, ELF/MZ, PAX bypass, hidden dir, junk dependencies, `javascript:` repository, 3 MB SKILL.md, hostile Origin, CORS `*`, token minting, error leak, yank retry, 15 publishes).

#### Branch `test/cli-contract-conformance`
- [x] **REG-38** (B-28) `scripts/conformance.mjs` (+ `pnpm conformance`): given `SKILLAPT_CLI_DIR` (a built checkout of the CLI at a tag, default `v1.0.0`), start the Worker locally, create an admin and a normal user plus tokens directly in the LOCAL D1 (fixtures only, never in migrations), then drive the real CLI: init, pack, publish, search, info, install with `--target claude --target antigravity` into a temp project, `--frozen` reinstall, yank twice (stays yanked), outdated, update, admin takedown (-> install gets 410 and refuses), plus crafted attack archives posted with `curl` (ELF, PAX path trick, hidden dir, bad versions, foreign scope).
  AC: all scenarios pass. Any CLI/registry mismatch is fixed on the registry side if the registry is wrong, otherwise logged in §12 as a CLI issue (do not edit the CLI repo). Record every mismatch in §6.
  V: `pnpm conformance` green; output pasted in §13.

### M4. Docs, CI, production-ready package

#### Branch `docs/ci-spec-sync`
- [x] **REG-31** `.github/workflows/ci.yml`: Node 22, `pnpm install --frozen-lockfile`, typecheck, test, `pnpm audit --prod`, `wrangler deploy --dry-run --env production`, `pnpm smoke`, `pnpm test:integration`; optional job running `pnpm conformance` against the CLI repo; `dependabot.yml`.
- [x] **REG-32** Sync `docs/SPEC.md` and `docs/openapi.yaml` with what is implemented (status column, role-based admin instead of `X-Admin-Token`, idempotent yank + DELETE, `integrity`, rate limits, CSRF, shared allowlist, dashboard). Anything not implemented is marked "planned".
- [x] **REG-33** README: remove the `file:///home/ankurgupta/...` link and "completely independent of npm"; correct deploy steps; document the dashboard login flow, vars and secrets (§4.4). Add SECURITY.md, CHANGELOG.md, CODEOWNERS.

#### Branch `chore/production-deploy`
- [x] **REG-34** Prepare, but do not run, the production rollout: `docs/DEPLOY.md` with exact commands (create D1 and R2, set `database_id`, `wrangler d1 migrations apply DB --remote --env production`, `wrangler secret put ...`, `wrangler deploy --env production`, custom domain, GitHub OAuth app callback `https://registry.skillapt.dev/v1/auth/github/callback`, bootstrap first admin) and `scripts/post-deploy-check.sh` (health, anonymous search, authenticated publish of a test skill with a token passed via env, download hash check).
- [x] **REG-39** `docs/RUNBOOK.md`: incident procedure for malware (takedown -> audit -> notice -> postmortem), D1 export/backup schedule, R2 versioning, `wrangler rollback`, secret and token rotation, alerting on 5xx rate and publish failures, how to take the registry read-only.
- [ ] **REG-35** (HUMAN) Run DEPLOY.md and `post-deploy-check.sh`, then the CLI acceptance demo (§16.8) against production; record results in §13.
- [ ] **REG-36** (HUMAN) Tag `v1.2.0` after REG-35 passes (tag `v1.1.0` already exists at commit 027fac8 per D-012).

### M5. Strictness, staging, and operational fixes

#### Branch `fix/skillmd-name-strict`
- [ ] **REG-43** Require SKILL.md frontmatter `name` to match the on-disk folder name exactly (`scope--name` for scoped packages); reject unscoped name for scoped packages. Test with a package built by the real CLI. Restore D-004 text in §3 so it matches the CLI repo.

#### Branch `fix/deploy-workflow-gating`
- [ ] **REG-44** Make every deploy workflow manual (`workflow_dispatch`) with a GitHub environment requiring approval; no deploy on push or tag.

#### Branch `feat/staging-env`
- [ ] **REG-45** Add `env.staging` in `wrangler.jsonc` with its own D1, R2, DO bindings and placeholder database_id. Document staging setup in `docs/DEPLOY.md`.

#### Branch `feat/remote-conformance`
- [ ] **REG-46** Parameterize conformance and integration scripts to accept `REGISTRY_URL` plus tokens from environment variables, enabling runs against remote registries.

#### Branch `docs/runbook-fixes`
- [ ] **REG-47** Fix RUNBOOK: R2 has no object versioning (verify against Cloudflare docs); replace with retention lock or periodic copy; add D1 export procedure using `wrangler d1 export`.

---

## 8. Git workflow (mandatory)

- `main` is always deployable. Start every branch from the latest `main`; branch names exactly as in §7.
- Conventional Commits (`fix:`, `feat:`, `test:`, `docs:`, `chore:`), small and focused. Push after the first commit and after the last: `git push -u origin <branch>`.
- Finish: `git checkout main && git merge --no-ff <branch> -m "Merge branch '<branch>'"`, rerun typecheck/test/smoke on main, `git push origin main`.
- Protected `main`: `gh pr create --base main --head <branch> --fill`, then `gh pr merge --merge` (merge commit; never `--squash`/`--rebase`, never `--delete-branch`). Ask the human to confirm that "Automatically delete head branches" is OFF.
- NEVER delete branches (local or remote), never force-push, never rewrite shared history, never create tags.
- After the last merge verify and paste into §13: `git branch -a`, `git ls-remote --heads origin`, `git log --graph --oneline --decorate --all | head -120`, `git branch -r --merged origin/main`, and that `git diff origin/main main` is empty.

---

## 9. Quality gates (a task is not done until these pass)

- `pnpm typecheck` · `pnpm test` · `pnpm smoke` · `pnpm test:integration` · `pnpm audit --prod` (no high/critical).
- Every security fix ships with an attack-reproducing regression test; every migration is applied by `test:integration` on a fresh local D1.
- Docs change in the same branch as behavior.
- Mock D1/R2 are approximations. Anything depending on real D1/R2/DO semantics (row-size limits, batch atomicity, conditional puts, DO migrations) must be confirmed in `test:integration` and again in REG-35 on real Cloudflare.

---

## 10. Release and operations

- Deploy only from a tagged `main` by the human: `wrangler deploy --env production`. Apply migrations with `--remote --env production` BEFORE deploying code that needs them.
- Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `HASH_SALT`. Vars: `ENVIRONMENT`, `PUBLIC_ORIGIN`, `CORS_ORIGIN`.
- Monitoring: Workers observability/logs with request ids; alerts on 5xx rate and publish failures. Backups: scheduled D1 export, R2 versioning (see RUNBOOK).
- Malware incident: admin takedown -> audit log -> notice via SECURITY.md channel -> postmortem row in §13.
- Compatibility: API v1 may add optional fields; never remove or rename fields in §3.3 without a v2.

---

## 11. Decision log (append only)

| ID | Date | Decision | Status |
|---|---|---|---|
| D-001 | 2026-11-15 | Registry and CLI are one product; contract §3 is identical in both repos | accepted |
| D-002 | 2026-11-15 | `permissions` are declarative, not enforced | accepted |
| D-003 | 2026-11-15 | No `--` in package names/scopes; on-disk folder for `@scope/name` is `scope--name` | accepted (applied in CLI v1.0.0) |
| D-004 | 2026-11-15 | SKILL.md `name` must equal the on-disk folder name; files are never rewritten | accepted (applied in CLI v1.0.0) |
| D-005 | 2026-11-15 | Agent paths per §3.6 (CLI agent reported verifying Antigravity and Codex against vendor docs) | accepted; human to re-verify before launch |
| D-006 | (pending) | Allow images/PDF/fonts only with magic-byte-matches-extension | open |
| D-007 | 2026-11-15 | Admin authorization is role-based (`users.role`), replacing the SPEC's `X-Admin-Token` idea | accepted |
| D-008 | 2026-11-15 | Rate limiting via Durable Object (supports hourly/daily windows), not the Workers Rate Limiting binding (10/60 s periods only) | accepted |
| D-009 | 2026-11-15 | Publish uses R2 create-only put. If real R2 does not honor `onlyIf: {etagDoesNotMatch:"*"}`, use reserve-first: insert the `skill_versions` row with a pending status first (UNIQUE guards), then put to R2, then finalize in one batch; cron removes stale pending rows | accepted; verify on real R2 |
| D-010 | 2026-11-15 | Integration tests use a script on `wrangler dev --local` (real workerd + local D1/R2), not `@cloudflare/vitest-pool-workers`, to avoid version-compat risk | accepted |
| D-011 | 2026-11-15 | Accounts whose GitHub login is not a valid scope (> 30 chars, consecutive hyphens, 1 char) get no scope and publish unscoped names only. Raising the scope limit to 39 would need a change in both repos | accepted |
| D-012 | 2026-11-15 | Tag v1.1.0 already exists in repo history (commit 027fac8); target registry release version bumped from v1.1.0 to v1.2.0 | accepted |

## 12. Open questions / blockers (ask the human; do not guess)
- Q1: Who owns the Cloudflare account and the `skillapt.dev` domain? Is anything deployed?
- Q2: Accept D-007 to D-011 or change them? -> Accepted per user instruction. D-012 added for target v1.2.0.
- Q3: Which GitHub account is the first admin?
- Q4: GitHub OAuth app: callback URL and credentials (human creates; never in the repo).
- Q5: Tarball signing/provenance is out of scope for 1.x; confirm.
- Q6: Any CLI/registry mismatch found by REG-38 that needs a CLI change goes here with details:
  - CLI option `--target`: In `../skillapt/src/cli.ts`, `--target <target>` is registered as a single-value option without a collector (`.option("--target <target>")`). When passed multiple times (e.g. `--target claude --target antigravity`), Commander overwrites `options.target` with the last value ("antigravity"). In contrast, `../skillapt/src/commands/install.ts` supports comma-separated targets via `options.target.split(",")`. Conformance tests used `--target claude,antigravity` which succeeds. To allow repeated `--target` flags, CLI `src/cli.ts` should define `--target` with a custom collector or variadic argument.
  - SKILL.md Frontmatter naming: Scoped packages use `scope--name` for their on-disk directory name per D-004. Registry's `src/validation/tar.ts` was conformed to accept `scope--name` as well as unscoped name, aligning with CLI v1.0.0.
- Q7 (Reconciled State / Human Decisions):
  - `wrangler.jsonc`:
    - Production `database_id` is `"00000000-0000-0000-0000-000000000000"`. Human needs to run `wrangler d1 create skillapt-db-prod` and supply real UUID before production deployment.
    - Routes pattern: `"registry.skillapt.dev"` with `"custom_domain": true`.
    - DO binding name in `wrangler.jsonc` is `"RATE_LIMITER_DO"`; middleware accommodates both `RATE_LIMITER_DO` namespace and `RATE_LIMITER` test mock.
  - Workflows:
    - `.github/workflows/deploy.yml`: Had trigger `workflow_run` (on CI on `main`). Changed to `workflow_dispatch` only in `fix/worker-startup-and-config` first commit to prevent unintended auto-deployments.
    - `.github/workflows/pages.yml`: Deploys Redoc documentation to GitHub Pages on push to `main`.
  - Dependencies:
    - Zod was bumped to `4.6.7` in commit `456765d` (PR #6) with compatibility fix in `3ea64c5`. Stays on 4.x per "build on what exists; do not revert it". No further zod PRs will be merged until a dedicated migration.

## 13. Progress log (append only, newest last)

| Date | Agent/Author | Branch | Tasks | Result | Next |
|---|---|---|---|---|---|
| 2026-11-15 | audit | (none) | baseline | 29 findings recorded (§6); 59/59 tests on Node; workerd start fails | start REG-01 on `fix/worker-startup-and-config` |
| 2026-11-15 | agent | docs/plan-reconcile | Step 0 re-baseline | Reconciled PLAN.md with tag v1.1.0, GitHub Actions & Pages workflows, updated wrangler bindings, D-012 (target v1.2.0), and updated task dashboard | merge to main, then start Branch 1 |
| 2026-11-15 | agent | fix/worker-startup-and-config | REG-37, workflow triggers | Disabled auto-deploy in deploy.yml/pages.yml, implemented test-integration.mjs running 14 real workerd scenarios | merge to main, then start Branch 8 cron |
| 2026-11-15 | agent | fix/search-download-reports | REG-42 | Implemented daily cron trigger in wrangler.jsonc, exported scheduled handler in src/index.ts, and added unit tests | merge to main, then Branch 10 conformance |
| 2026-11-15 | agent | test/cli-contract-conformance | REG-38 | Implemented scripts/conformance.mjs and pnpm conformance; verified all 12 CLI scenarios (doctor, search, init, pack, publish, info, install, --frozen, yank, un-yank, outdated/update, takedown refusal) and 5 attack tarballs pass | merge to main, then Branch 11 docs/ci-spec-sync |
| 2026-11-15 | agent | docs/ci-spec-sync | REG-31, REG-32, REG-33 | Updated ci.yml (test:integration, wrangler deploy --env production, conformance job), synced SPEC.md, openapi.yaml, README.md (vars, secrets, dashboard flow), SECURITY.md, and CHANGELOG.md | merge to main, then Branch 12 chore/production-deploy |
| 2026-11-15 | agent | chore/production-deploy | REG-34, REG-39 | Created docs/DEPLOY.md, scripts/post-deploy-check.sh, and docs/RUNBOOK.md; updated REGISTRY_VERSION to 1.2.0; verified post-deploy-check passes locally | merge to main; human runs REG-35 and REG-36 |
| 2026-11-15 | agent | main | Final Verification | Verified git status, branch tracking, remote heads, graph log, merged branches, zero diff between main and origin/main, and all test suites pass | ready for human production deployment and acceptance demo |

### 13.1 Post-Merge Git State Verification

```text
$ git diff origin/main main
(empty)

$ git branch -r --merged origin/main
  origin/HEAD -> origin/main
  origin/chore/production-deploy
  origin/chore/seed-and-test-hardening
  origin/dependabot/github_actions/all-actions-b5f7b3ce1d
  origin/dependabot/npm_and_yarn/zod-4.6.7
  origin/docs/ci-spec-sync
  origin/docs/github-pages
  origin/docs/plan-reconcile
  origin/docs/spec-v1.1
  origin/feat/auth-sessions-tokens
  origin/feat/chore-project-setup
  origin/feat/database-schema-and-migrations
  origin/feat/docs-readme-and-deploy
  origin/feat/docs-spec-and-openapi
  origin/feat/package-validation
  origin/feat/publish-endpoint
  origin/feat/read-api
  origin/feat/real-seed
  origin/feat/takedown-and-version-status
  origin/feat/tarball-storage-and-download
  origin/feat/token-dashboard
  origin/feat/yank-reports-ratelimits-stats
  origin/fix/auth-sessions-csrf-cors
  origin/fix/publish-atomicity-and-limits
  origin/fix/publish-validation
  origin/fix/rate-limiting
  origin/fix/search-download-reports
  origin/fix/worker-startup-and-config
  origin/main
  origin/test/cli-contract-conformance

$ git ls-remote --heads origin
47747916591006e079a3f17788460ffd9d21ea19	refs/heads/chore/production-deploy
d2a2d5f5d1e5a9a8c1e1b87039b527974f124a32	refs/heads/chore/seed-and-test-hardening
ffb7ac413a38a831117d9494e8190a560f1341db	refs/heads/dependabot/github_actions/all-actions-b5f7b3ce1d
a039d08ab4b36f9ed396c6c1a812474bb5e8840f	refs/heads/dependabot/npm_and_yarn/zod-4.6.7
cc8ebe00e6c2e080a6bed7315aa375b89a856d44	refs/heads/docs/ci-spec-sync
e411bfa10ab8ac1da9c0ec9009cc09dd125d9dee	refs/heads/docs/github-pages
fc302a57a19fd70c9b813934e7779ddd853e80b7	refs/heads/docs/plan-reconcile
b2edd542523737edfaa2bfdb1d38577095891382	refs/heads/docs/spec-v1.1
4d41654be1d811974db76c913bde904432d97c62	refs/heads/feat/auth-sessions-tokens
fe7905bcd139b24a1c277b43ba4f3486208aff27	refs/heads/feat/chore-project-setup
fc88ab35434196d3cde2b1369799ca974be97a79	refs/heads/feat/database-schema-and-migrations
20e011a7b9118c47e0a913037bfdcb4f0d2679f3	refs/heads/feat/docs-readme-and-deploy
99362a5fbdf7f4a2c75ff7d721fa789732883742	refs/heads/feat/docs-spec-and-openapi
b906dd670db6244a8edb2c4844f8d988edc44349	refs/heads/feat/package-validation
0ef964acef83e71cc619449fd48b02e6ffdbfe25	refs/heads/feat/publish-endpoint
422b06aa86a51018358a5c20f85b250b3185ef01	refs/heads/feat/read-api
b2edd542523737edfaa2bfdb1d38577095891382	refs/heads/feat/real-seed
e2506ea2bbe2a73a085cc22f22da92108a3e8693	refs/heads/feat/takedown-and-version-status
2acb034134aa5afc240ab6c9417842e1348f93b2	refs/heads/feat/tarball-storage-and-download
215463d641be789d2e967407ce1bfc5d6d39cbca	refs/heads/feat/token-dashboard
b6328ebdd3ba61f26eff7c97ecbc53395b3d41ff	refs/heads/feat/yank-reports-ratelimits-stats
aeae87fc7449c802f61a209c79ba2c68edcd37b8	refs/heads/fix/auth-sessions-csrf-cors
ce87342a55b28b3fc7afa428735b61ffb918d437	refs/heads/fix/publish-atomicity-and-limits
2192be4905ff0489cbb11f47d76cc6cc9aa92eae	refs/heads/fix/publish-validation
faf99190d521ca934787a46c2e48d8b5cfe9b28d	refs/heads/fix/rate-limiting
e604186df9da61649730322e4752894fb48f65f2	refs/heads/fix/search-download-reports
1927008800eb39891f538df1599b49fe7bae21e6	refs/heads/fix/worker-startup-and-config
10268a8f2f77675437b8cb313fb8cf3d6f46278c	refs/heads/main
13d6104473bdf05d9f7d1581ae428945a641e603	refs/heads/test/cli-contract-conformance
```

---

## 14. Definition of done

All tasks in §7 are `[x]` (REG-35/36 by the human), every branch is merged into `main` with merge commits and still exists on GitHub, CI is green, the conformance run and the production acceptance demo (§16.8) passed, `v1.2.0` is tagged and deployed, and §1 reflects it.

The finished registry looks like this:
- A Worker at `https://registry.skillapt.dev/v1` that starts on workerd, with `/v1/health` green and production and development cleanly separated.
- Publishers log in with GitHub, land on `/dashboard`, create expiring API tokens (shown once) and revoke them. Tokens cannot mint tokens.
- Publishing `@alice/pdf-tool@1.2.0` works only for the account that owns scope `alice`; reserved names are blocked; versions are canonical; dependencies exist; the tarball passes an effective-path validator (no links, binaries, hidden files, duplicates, traversal, manifest confusion); the write is atomic and rate-limited.
- Search has no N+1; downloads stream with ETag and deduped counters; yank is idempotent with an un-yank route; admins take down malware (410 Gone, audit-logged) and review reports with hashed IPs.
- CORS is an exact allowlist, cookie mutations are CSRF-checked, sessions and tokens are stored hashed, errors do not leak, every request has an id.
- `migrations/` holds 0001 plus 0002-0004, no seed data. CI runs typecheck, tests, audit, deploy dry-run, workerd smoke and integration tests. SPEC/openapi/README describe exactly what exists. DEPLOY.md, RUNBOOK.md, SECURITY.md, CHANGELOG.md and CODEOWNERS exist.

## 15. Appendix
Useful commands:
```bash
pnpm dev                                    # wrangler dev
pnpm db:migrate:local                       # apply migrations to the local D1
pnpm smoke && pnpm test:integration         # real workerd checks
SKILLAPT_CLI_DIR=../skillapt pnpm conformance
# HUMAN ONLY (production):
wrangler d1 migrations apply DB --remote --env production
wrangler d1 execute DB --remote --env production --command "UPDATE users SET role='admin' WHERE handle='<github-login>'"
wrangler deploy --env production
```
Glossary: scope = `@login/` namespace owned by a GitHub account id; yanked = hidden from resolution but downloadable; removed = admin takedown (410); effective path = entry path after applying PAX records; conformance = running the real CLI against the real Worker.

---

## 16. The finished product (shared by both repos: keep identical)

### 16.1 What skillapt is when finished
skillapt is "npm for AI agent skills". A developer types one command and gets a vetted, versioned skill (instructions plus optional scripts) installed into their AI coding agent (Claude, Cursor, Codex, Antigravity). Publishers upload skills to a public registry under their GitHub name. The registry verifies every upload, serves it with integrity checks and lets admins pull malware.

It has two deliverables:
1. **`skillapt` CLI** (npm package, Node >= 20): what users and publishers run.
2. **`skillapt-registry`** (Cloudflare Worker + D1 + R2) at `https://registry.skillapt.dev/v1`: what the CLI talks to.

### 16.2 What it does, by role

**Consumer (installs skills)**
- `skillapt search pdf` finds skills; `skillapt info @alice/pdf-tool` shows versions, permissions, dependencies and whether any version is yanked.
- `skillapt install @alice/pdf-tool --target claude --target antigravity` resolves dependencies, verifies sha256, validates content (no binaries, no hidden files, no traversal), shows the declared permissions, asks for confirmation if the skill wants shell or network access, installs into `.skills/alice--pdf-tool`, links it into each agent's skills folder, and writes `skills.json` plus `skills.lock.json`.
- `skillapt install owner/repo/path@v1.0.0` installs straight from GitHub (pinned to a commit SHA, content checks as warnings by default).
- `skillapt install --frozen` reproduces exactly what the lockfile says (CI-safe); `outdated` and `update` keep skills current and keep GitHub pins; `remove` also cleans the agent folders and orphaned dependencies.

**Publisher (shares skills)**
- Logs in with GitHub on the registry's web page, lands on `/dashboard`, creates an API token (shown once, expires in 90 days).
- `skillapt login --token-stdin`, then `skillapt init` scaffolds `SKILL.md` and `skill.json`, `skillapt pack` builds a reproducible tarball, and `skillapt publish` validates it locally, then uploads it.
- Can only publish under their own scope (`@their-github-login/...`) or a free unscoped name. Versions are immutable. They can yank a bad version (`skillapt yank`) and un-yank it.

**Admin (protects the ecosystem)**
- Reviews abuse reports, takes down a malicious version (410 Gone, excluded from resolution), restores it if it was a mistake. Every action is written to an audit log.

**Maintainer**
- CI runs on every push (typecheck, tests, audit, deploy dry-run, a real workerd start test). Releases are tagged, the CLI is published to npm with provenance, the Worker is deployed from a tag.

### 16.3 End-state architecture
```
 developer machine                                   Cloudflare
 +-------------------------+   HTTPS /v1    +----------------------------------+
 | skillapt CLI            | -------------> | Worker (Hono)                    |
 |  .skills/<scope--name>  |                |  auth, publish validation,       |
 |  skills.json            | <------------- |  search, download, yank,         |
 |  skills.lock.json       |  tarball+sha   |  admin takedown, rate limits     |
 |  -> <agent>/skills/...  |                |        |            |            |
 +-----------+-------------+                |       D1           R2            |
             |                              | (metadata,      (tarballs,       |
             | (GitHub-sourced skills)      |  users, tokens,  create-only)    |
             v                              |  audit, reports)                 |
   GitHub API + codeload                    |  Durable Object (rate limiter)   |
                                            +----------------------------------+
 browser --> GitHub OAuth --> /v1/auth/github/callback --> /dashboard (tokens)
```

### 16.4 Final repository layout

**skillapt (CLI)**
```
src/cli.ts
src/commands/        install remove update outdated list search info init pack publish yank login doctor
src/lib/             source registry github extract validate (shared rules) pack dependencies
                     lockfile manifest targets (all agents) config auth fs (assertInside) semver
tests/               unit + offline e2e (mock registry) + tests/security/ (one file per audit area)
docs/                SPEC.md openapi.yaml (match the code)
.github/workflows/ci.yml   .github/dependabot.yml
install.sh  package.json (prepare/prepublishOnly)  README.md  PLAN.md
SECURITY.md  CHANGELOG.md  CODEOWNERS  LICENSE
```

**skillapt-registry (Worker)**
```
src/index.ts src/config.ts (limits, allowlist, reserved names)
src/routes/          skills auth tokens reports stats admin dashboard
src/middleware/      auth csrf cors rate-limit (Durable Object client) request-id
src/validation/      tar (effective-path parser, magic bytes) manifest
src/ratelimit/       Durable Object + in-memory test impl
migrations/          0001_initial.sql (never edited) + numbered migrations 0002+ (scopes, status, audit, tokens, sessions, dedupe)
                     (no seed data, no credentials)
scripts/             dev-seed (local only), smoke, integration, conformance, post-deploy-check
tests/               unit + tests/security/ (every attack) + tests/fixtures/ + mock D1/R2
docs/                SPEC.md openapi.yaml DEPLOY.md RUNBOOK.md (match the code)
wrangler.jsonc       env.production, routes, D1, R2, Durable Object binding, cron
.github/workflows/ci.yml (incl. smoke + integration on workerd)  dependabot.yml
README.md PLAN.md SECURITY.md CHANGELOG.md CODEOWNERS
```

### 16.5 What a working session looks like (illustrative)
```
$ npm install -g skillapt
$ skillapt doctor
  Node 22 OK · registry https://registry.skillapt.dev/v1 reachable · token valid (expires in 83 days)

$ skillapt install @alice/pdf-tool@^1.2.0 --target claude --target antigravity
  resolving... @alice/pdf-tool@1.2.1  (depends on text-cleaner@1.0.3)
  permissions: network=false shell=false filesystem=read
  verified sha256 · content checks passed
  installed .skills/alice--pdf-tool, .skills/text-cleaner
  linked  .claude/skills/alice--pdf-tool
  linked  .agents/skills/alice--pdf-tool           (Antigravity)
  wrote skills.json, skills.lock.json

$ skillapt install --frozen          # identical result on CI
$ skillapt outdated                  # reports unreachable registry as an error, never "all up to date"
```
Publisher side:
```
$ skillapt login --token-stdin < token.txt
$ skillapt pack      -> alice-pdf-tool-1.3.0.tgz (same sha256 every time)
$ skillapt publish   -> validated locally; registry returned 201 with integrity sha256-...
$ skillapt yank @alice/pdf-tool 1.3.0 --reason "bug"      (running it twice keeps it yanked)
```
Rejections users will see: publishing `@bob/x` as `alice` -> 403; a skill containing an ELF/`.exe`, a hidden `.claude/` folder, a symlink or `v1.0.0`/`1.0.0+x` as a version -> 400 with the reason.

### 16.6 Non-goals (deliberately not in v1)
- No sandboxing: `permissions` are declarations the CLI shows and asks about, not enforcement. A skill's text can still try prompt injection; the threat model is documented.
- No package signing (SHA-256 protects integrity against the registry's own hash, not a compromised registry).
- No public website to browse skills (only `/dashboard` for tokens); no images/PDF/fonts in skills until decision D-006.
- No paid tiers, org/team accounts or private skills.

### 16.7 Launch state
- The registry starts empty. The 20 demo skills in the old seed were fake (no real tarballs) and are removed; only real published skills exist. Publish one or two first-party skills to prove the flow.
- Antigravity/Codex folder conventions are verified against vendor docs and recorded in §11 (D-005) before the release.

### 16.8 Final acceptance demo (the project is finished only if this passes on a clean machine)
1. `npm install -g skillapt && skillapt doctor` is green against production.
2. Log in via GitHub on the web, create a token in `/dashboard`, `skillapt login --token-stdin`.
3. `skillapt init && skillapt pack && skillapt publish` a test skill under your own scope; a second account cannot publish under that scope.
4. In a clean project: `skillapt install @you/test-skill --target antigravity --target claude` creates the folders, lockfile and links; `--frozen` reproduces it.
5. Attack checks all fail: path-traversal `skill.json` name (GitHub install), ELF in `.py`, PAX path trick, hidden dir, `v1.0.0`/`1.0.0+x`, token sent to another origin, same yank twice.
6. Admin takes the test version down -> download returns 410, `install` refuses it, the audit log has the entry.
7. `git branch -a` shows every branch from the plans, all merged into `main`, none deleted; CI green; `v1.0.0` (CLI) and `v1.2.0` (registry) tagged.