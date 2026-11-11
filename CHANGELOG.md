# Changelog

All notable changes to the Skillapt Registry will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-11

### Added
- **Scope Ownership & GitHub Claims**: Claimed GitHub handles as scope owners upon login; `@scope/name` packages can only be published by the scope owner keyed by GitHub ID (`migrations/0002_scopes_and_latest_version.sql`).
- **Strict Publish Validation & Hardened Tar Parser**:
  - Reserved package names and scopes (including `skillapt`, `admin`, `api`, `claude`, `openai`, `gemini`, etc.).
  - Canonical semver check (strictly matching `semver.valid(v) === v` with no build metadata).
  - Manifest validation for dependencies (max 50, depth <= 10, no cycles, valid ranges), compatibility, repository HTTPS, license, keywords, and SKILL.md frontmatter parsing via `yaml`.
  - Tarball validation: checksum verification, allowed type flags (`0`, `\0`, `5`), PAX header `x` support, single root wrapper directory, duplicate path rejection, forbidden hidden files, 512-byte magic byte detection (ELF, Mach-O, PE, Java Class, WASM), file extension allowlist, and 25 MB decompressed limit.
- **Atomic Publish Pipeline & R2 Create-Only Put**:
  - Size-capped streaming request bodies (max 5 MB) with strict Content-Length checking.
  - Create-only R2 upload using `onlyIf: { etagDoesNotMatch: "*" }` returning HTTP 409 on version conflict.
  - Single atomic D1 `batch()` operation for skill upsert, version metadata, and dependencies; automatic R2 cleanup on failure.
  - Subresource integrity format (`sha256-<hex>`) returned alongside sha256 checksums.
  - Automatic `latest_version` tracking pointing to the highest stable active version.
- **Takedown & Version Status Management**:
  - Version statuses (`active`, `yanked`, `removed`), removal reason, and audit log table (`migrations/0003_takedown_and_version_status.sql`).
  - Admin endpoints (`/v1/admin/skills/:name/:version/takedown`, `/restore`, `/reports`, `/reports/:id/resolve`) guarded by `role = 'admin'`.
  - HTTP 410 Gone for removed versions on download with `Cache-Control: no-store` and omitted tarball URLs.
  - Idempotent `POST /v1/skills/:name/:version/yank` and `DELETE /v1/skills/:name/:version/yank` (un-yank).
- **Session & Token Security**:
  - CSRF origin validation on cookie-authenticated mutating requests.
  - Strict CORS exact allowlist, rejecting wildcard `*` with credentials and localhost in production.
  - SHA-256 hashed session identifiers, automatic expired session cleanup, and session rotation on login (`migrations/0004_auth_tokens_and_sessions.sql`).
  - API token minting and revocation restricted to authenticated browser sessions, capped at 20 active tokens per user with default 90-day expiration.
  - Production error handler masking sensitive internal details with request IDs.
- **Server-Rendered Token Dashboard**:
  - `GET /dashboard` providing a minimal, scriptless HTML interface with strict Content Security Policy (`script-src 'none'`) and CSRF tokens.
- **Durable Object Rate Limiting**:
  - Cloudflare Durable Objects (`RateLimiterDO`) for distributed sliding-window rate limiting.
  - Client identification using `cf-connecting-ip`.
  - Standardized HTTP 429 response schema with RFC-compliant headers (`Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`).
- **Optimized Search, Caching & Abuse Reporting**:
  - Single paginated query in `GET /v1/skills` eliminating N+1 queries.
  - SQL `LIKE` wildcard escaping and query length caps.
  - Conditional HTTP 304 Not Modified responses on `If-None-Match`, immutable caching for active tarballs.
  - Deduplicated daily download counters per IP hash (`migrations/0005_download_dedupe_and_report_privacy.sql`).
  - Hashed reporter IP addresses using `REPORT_SALT` in abuse reports for privacy compliance.
- **Automated CI/CD & Testing**:
  - GitHub Actions CI workflow covering typechecking, tests, production dependency auditing, Wrangler deploy dry-run, and workerd smoke testing.
  - Dependabot automated updates for npm and GitHub Actions.
  - Table-driven security attack regression suite (`tests/security/all-attacks-regression.test.ts`).
  - Isolated test fixtures and safe local database seeding script (`pnpm db:seed`).

### Changed
- Upgraded Wrangler to v4, Zod to patched 3.25.76, Hono to 4.13.16, and Semver to 7.8.6.
- Configured Node.js `>=22.5` engine requirement and pnpm package manager.
- Updated `wrangler.jsonc` with production environment bindings, routes, and observability.
