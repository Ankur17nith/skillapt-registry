# skillapt-registry

> The independent package registry for AI agent skills. Built with **TypeScript**, **Hono**, **Cloudflare Workers**, **Cloudflare D1**, and **Cloudflare R2**.

`skillapt` is a dedicated, secure package manager and registry designed specifically for **AI agent skills** (compatible with Claude, Cursor, Codex, Antigravity, and custom agentic runtimes), distributing immutable, sandboxed `.tar.gz` packages with declarative permission policies.

The branding and product name lives in exactly one constant: [`PRODUCT_NAME`](src/config.ts) in `src/config.ts`.

---

## Architecture & Core Philosophy

1. **Zero Execution on Registry**: The registry never executes or evaluates untrusted package code. All package tarballs are statically inspected and served as static assets.
2. **Strict Package Validation**:
   - Tarballs must be gzip archives (`.tar.gz` or `.tgz`) under **5 MB** compressed, **25 MB** uncompressed.
   - Allowed file types: Documentation (`.md`, `.txt`, `.prompt`, `.rst`), data (`.json`, `.yaml`, `.csv`, `.tsv`, `.xml`, `.xsd`), web assets (`.html`, `.css`, `.svg`), templates (`.jinja`, `.mustache`, `.hbs`), and scripts (`.py`, `.ts`, `.sh`, `.bash`, etc.).
   - Header validation, magic byte checking (rejects ELF, Mach-O, PE MZ, Java class, WASM), and path normalization (rejects symlinks, hardlinks, absolute paths, duplicate paths, and traversal `..`).
   - Mandatory non-empty [`SKILL.md`](docs/SPEC.md) with valid YAML frontmatter and [`skill.json`](docs/SPEC.md) manifest.
3. **Immutable Releases & Atomicity**:
   - Versions are frozen upon publication. Once published, a version's tarball and metadata cannot be altered or overwritten.
   - Create-only R2 uploads (`onlyIf: { etagDoesNotMatch: "*" }`) and atomic D1 `batch()` metadata insertion with automatic rollback on failure.
   - Attempting to overwrite an existing version returns `409 Conflict`.
4. **Resilient Yank Behavior**:
   - Package owners can yank compromised versions idempotently via `POST /v1/skills/:name/:version/yank` (with optional reason) and un-yank via `DELETE /v1/skills/:name/:version/yank`.
   - Yanked versions are hidden from general search and SemVer range resolution (`^1.0.0`), but direct pinned downloads remain accessible so existing builds and lockfiles never break.
5. **Admin Takedowns & Version Status**:
   - Malicious packages can be taken down by administrators via `/v1/admin/skills/:name/:version/takedown`, setting version status to `removed`.
   - Downloads of removed versions return `410 Gone` with `Cache-Control: no-store` and omitted download URLs in metadata.
6. **Cryptographic Checksums**:
   - SHA-256 digests and integrity strings (`sha256-<hex>`) are computed upon publish and verified by the CLI during installation against [`skills.lock.json`](docs/SPEC.md).
7. **Authentication & Token Security**:
   - Web sessions: GitHub OAuth 2.0 with HTTP-only, secure, SameSite cookies and CSRF origin verification on mutating requests.
   - Web Dashboard (`/dashboard`): Server-rendered HTML dashboard with strict CSP (`script-src 'none'`) and CSRF protection for managing personal access tokens.
   - CLI operations: Personal access tokens (`apt_live_...`). Generating and revoking tokens requires an active web session. Raw tokens are shown **only once** upon generation; the database stores exclusively the SHA-256 hash.
   - CLI login flow:
     1. Visit `https://registry.skillapt.dev/dashboard` (or `http://localhost:8787/dashboard` in development).
     2. Sign in with GitHub.
     3. Generate a token, copy it, and configure your CLI via `skillapt config set token <token>`.
8. **Durable Object Rate Limiting**:
   - Sliding-window rate limiting enforced globally using Cloudflare Durable Objects (`RateLimiterDO`).
   - Tracks client IP using `cf-connecting-ip`.
   - Standard 429 response body with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.
9. **Deduplicated Downloads & Caching**:
   - Downloads cached at Cloudflare edge (`Cache-Control: public, max-age=31536000, immutable`).
   - Conditional requests with `If-None-Match` return `304 Not Modified`.
   - Deduplicated daily download counters per IP hash via `download_dedupe` table.

---

## Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (Edge Compute)
- **Web Framework**: [Hono](https://hono.dev/) v4
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (Serverless SQLite)
- **Object Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/) (S3-compatible bucket)
- **Rate Limiting**: Cloudflare Durable Objects (`RateLimiterDO`)
- **Validation**: [Zod](https://zod.dev/) & [SemVer](https://github.com/npm/node-semver)
- **Testing**: [Vitest](https://vitest.dev/) (Unit & Integration tests with in-memory SQLite and R2 mocks)
- **Package Manager**: `pnpm`

---

## Local Development & Testing

### 1. Prerequisites
- Node.js `>=22.5`
- `pnpm`

### 2. Installation
```bash
git clone https://github.com/Ankur17nith/skillapt-registry.git
cd skillapt-registry
pnpm install
```

### 3. Run Test Suite
```bash
# Run all unit and integration tests with vitest
pnpm test

# Run TypeScript typecheck
pnpm typecheck

# Run production dependency audit
pnpm audit --prod

# Run workerd runtime smoke test
pnpm smoke
```

### 4. Local Database Setup & Migrations
```bash
# Apply migrations to local D1 SQLite
pnpm db:migrate:local

# Seed 20 realistic agent skills and demo users safely (refuses --remote and production)
pnpm db:seed
```

### 5. Start Local Development Server
```bash
pnpm dev
# Registry runs locally at http://localhost:8787
```

---

## API Reference Overview

All API endpoints are mounted under `/v1` (with the web token dashboard mounted at `/dashboard`):

| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/health` | Health check endpoint | Public |
| `GET` | `/v1/skills` | Search, filter, and list skills (paginated, single query) | Public (Rate-limited) |
| `GET` | `/v1/skills/:name` | Skill details, readme, and versions map | Public |
| `GET` | `/v1/skills/:name/:version` | Exact version metadata and integrity hash | Public |
| `GET` | `/v1/skills/:name/-/:file` | Download package tarball (`.tgz`) | Public |
| `POST`| `/v1/skills` | Publish new package or version (`multipart/form-data`) | Bearer Token / Session |
| `POST`| `/v1/skills/:name/:version/yank` | Idempotent yank of a published version | Owner only |
| `DELETE`| `/v1/skills/:name/:version/yank` | Idempotent un-yank of a published version | Owner only |
| `POST`| `/v1/admin/skills/:name/:version/takedown` | Admin takedown of a version (`status = 'removed'`) | Admin Role |
| `POST`| `/v1/admin/skills/:name/:version/restore` | Admin restoration of a version | Admin Role |
| `GET` | `/v1/admin/reports` | List abuse reports with status filter & pagination | Admin Role |
| `POST`| `/v1/admin/reports/:id/resolve` | Mark abuse report as resolved | Admin Role |
| `GET` | `/dashboard` | Server-rendered HTML token management dashboard | Session Cookie |
| `GET` | `/v1/me` | Authenticated user profile | Bearer Token / Session |
| `GET` | `/v1/tokens` | List user's active API tokens | Session Cookie |
| `POST`| `/v1/tokens` | Generate new API token (`apt_live_...`) | Session Cookie |
| `DELETE`| `/v1/tokens/:id` | Revoke an API token | Session Cookie |
| `GET` | `/v1/auth/github` | Initiate GitHub OAuth authorization flow | Public |
| `GET` | `/v1/auth/github/callback` | OAuth redirect callback handler (claims scope) | Public |
| `POST`| `/v1/auth/logout` | Terminate session and clear cookie | Session Cookie |
| `POST`| `/v1/reports` | Submit abuse or vulnerability report (salted IP hash) | Public (Rate-limited) |
| `GET` | `/v1/stats` | Homepage counts and platform aggregates | Public |

For complete schemas, request/response examples, and error envelope definitions, refer to:
- [`docs/SPEC.md`](docs/SPEC.md)
- [`docs/openapi.yaml`](docs/openapi.yaml)

---

## GitHub OAuth App Setup Guide

To enable GitHub login for the skillapt web dashboard:

1. Navigate to **GitHub Settings** -> **Developer Settings** -> **OAuth Apps** -> **New OAuth App**.
2. Fill in the details:
   - **Application name**: `Skillapt Registry`
   - **Homepage URL**: `https://skillapt.dev` (or `http://localhost:3000` for local testing)
   - **Authorization callback URL**: `https://registry.skillapt.dev/v1/auth/github/callback` (or `http://localhost:8787/v1/auth/github/callback` in local dev)
3. Click **Register application**.
4. Copy the **Client ID**.
5. Generate a new **Client Secret** and copy it immediately.
6. Configure the variables in your deployment environment (see below).

---

## Production Deployment Steps (Cloudflare)

### 1. Authenticate with Wrangler
```bash
npx wrangler login
```

### 2. Cloudflare Resources & Bindings
Ensure the following bindings are configured in [`wrangler.jsonc`](wrangler.jsonc) under `env.production`:

- **D1 Database**: `DB` (`skillapt-db`)
  ```bash
  npx wrangler d1 create skillapt-db
  ```
  Set the returned `database_id` in `wrangler.jsonc`.

- **R2 Storage Bucket**: `STORAGE` (`skillapt-packages`)
  ```bash
  npx wrangler r2 bucket create skillapt-packages
  ```

- **Durable Object Binding**: `RATE_LIMITER_DO` (`RateLimiterDO`)
  The Durable Object class `RateLimiterDO` is compiled with the worker and provides sliding-window rate limiting.

### 3. Run Production Database Migrations
```bash
npx wrangler d1 migrations apply DB --remote
```

### 4. Configure Production Secrets
Never commit secrets to git. Inject them securely via Wrangler into production:
```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put REPORT_SALT
```

### 5. Bootstrap the First Admin User
After signing in via GitHub OAuth, elevate your user to admin role:
```bash
# In production:
npx wrangler d1 execute DB --remote --command="UPDATE users SET role = 'admin' WHERE handle = '<your-github-handle>';"

# In local development:
npx wrangler d1 execute DB --local --command="UPDATE users SET role = 'admin' WHERE handle = '<your-github-handle>';"
```

### 6. Deploy the Worker
```bash
pnpm deploy
```
Your `skillapt` registry worker is now live at `registry.skillapt.dev`!

---

## Example Usage with cURL

### 1. Search Skills
```bash
curl -s "http://localhost:8787/v1/skills?q=pdf&category=documents" | jq .
```

### 2. Get Skill Details
```bash
curl -s "http://localhost:8787/v1/skills/pdf-summarizer" | jq .
```

### 3. Generate a CLI Token (via Session Dashboard or API)
```bash
curl -s -X POST "http://localhost:8787/v1/tokens" \
  -H "Cookie: skillapt_session=<YOUR_SESSION_ID>" \
  -H "Origin: http://localhost:8787" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-workstation"}' | jq .
```

### 4. Publish a Skill Package
```bash
curl -X POST "http://localhost:8787/v1/skills" \
  -H "Authorization: Bearer <YOUR_API_TOKEN>" \
  -F "file=@my-agent-skill.tar.gz"
```

### 5. Download a Package Tarball
```bash
curl -s -O -J "http://localhost:8787/v1/skills/pdf-summarizer/-/1.2.0.tgz"
```

---

## License

MIT © 2026 Skillapt Team
