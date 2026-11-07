# skillapt-registry

> The independent package registry for AI agent skills. Built with **TypeScript**, **Hono**, **Cloudflare Workers**, **Cloudflare D1**, and **Cloudflare R2**.

`skillapt` is a dedicated, secure package manager and registry designed specifically for **AI agent skills** (compatible with Claude, Cursor, Codex, Antigravity, and custom agentic runtimes). It operates **completely independent of npm**, distributing immutable, sandboxed `.tar.gz` packages with declarative permission policies.

The branding and product name lives in exactly one constant: [`PRODUCT_NAME`](file:///home/ankurgupta/skillapt-registry/src/config.ts#L5) in `src/config.ts`.

---

## Architecture & Core Philosophy

1. **Zero Execution on Registry**: The registry never executes or evaluates untrusted package code. All package tarballs are statically inspected and served as static assets.
2. **Strict Package Validation**:
   - Tarballs must be gzip archives (`.tar.gz` or `.tgz`) under **5 MB** compressed, **25 MB** uncompressed.
   - Allowed file types: Documentation (`.md`, `.txt`, `.prompt`), data (`.json`, `.yaml`, `.csv`), templates (`.jinja`, `.mustache`), and scripts (`.py`, `.ts`, `.sh`, etc.).
   - Symlinks, hardlinks, special device nodes, absolute paths, and path traversal (`..`) are strictly rejected.
   - Mandatory non-empty [`SKILL.md`](file:///home/ankurgupta/skillapt-registry/docs/SPEC.md) and [`skill.json`](file:///home/ankurgupta/skillapt-registry/docs/SPEC.md) manifest.
3. **Immutable Releases**:
   - Versions are frozen upon publication. Once `1.0.0` is published, its tarball and checksum cannot be altered or overwritten.
   - Attempting to overwrite an existing version returns `409 Conflict`.
4. **Resilient Yank Behavior**:
   - Package owners can yank compromised versions.
   - Yanked versions are hidden from general search and SemVer range resolution (`^1.0.0`), but direct pinned downloads remain accessible so existing builds and lockfiles never break.
5. **Cryptographic Checksums**:
   - SHA-256 digests are computed upon publish and verified by the CLI during installation against [`skillapt-lock.json`](file:///home/ankurgupta/skillapt-registry/docs/SPEC.md).
6. **Authentication & Token Security**:
   - Web sessions: GitHub OAuth 2.0 with HTTP-only, secure, SameSite cookies.
   - CLI operations: Personal access tokens (`apt_live_...`). Raw tokens are shown **only once** upon generation; the database stores exclusively the SHA-256 hash.

---

## Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (Edge Compute)
- **Web Framework**: [Hono](https://hono.dev/) v4
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (Serverless SQLite)
- **Object Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/) (S3-compatible bucket)
- **Validation**: [Zod](https://zod.dev/) & [SemVer](https://github.com/npm/node-semver)
- **Testing**: [Vitest](https://vitest.dev/) (Unit & Integration tests with in-memory SQLite and R2 mocks)
- **Package Manager**: `pnpm`

---

## Local Development & Testing

### 1. Prerequisites
- Node.js `v22+` or `v24+`
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
```

### 4. Local Database Setup & Migrations
```bash
# Apply initial migrations to local D1 SQLite
pnpm db:migrate:local

# Seed 20 realistic agent skills and demo users
pnpm db:seed:local
```

### 5. Start Local Development Server
```bash
pnpm dev
# Registry runs locally at http://localhost:8787
```

---

## API Reference Overview

All API endpoints are mounted under `/v1`:

| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/health` | Health check endpoint | Public |
| `GET` | `/v1/skills` | Search, filter, and list skills | Public (Rate-limited) |
| `GET` | `/v1/skills/:name` | Skill details, readme, and versions map | Public |
| `GET` | `/v1/skills/:name/:version` | Exact version metadata and integrity hash | Public |
| `GET` | `/v1/skills/:name/-/:file` | Download package tarball (`.tgz`) | Public |
| `POST`| `/v1/skills` | Publish new package or version (`multipart/form-data`) | Bearer Token / Session |
| `POST`| `/v1/skills/:name/:version/yank` | Yank a published version | Owner only |
| `GET` | `/v1/me` | Authenticated user profile | Bearer Token / Session |
| `GET` | `/v1/tokens` | List user's active API tokens | Bearer Token / Session |
| `POST`| `/v1/tokens` | Generate new API token (`apt_live_...`) | Bearer Token / Session |
| `DELETE`| `/v1/tokens/:id` | Revoke an API token | Bearer Token / Session |
| `GET` | `/v1/auth/github` | Initiate GitHub OAuth authorization flow | Public |
| `GET` | `/v1/auth/github/callback` | OAuth redirect callback handler | Public |
| `POST`| `/v1/auth/logout` | Terminate session and clear cookie | Session Cookie |
| `POST`| `/v1/reports` | Submit abuse or vulnerability report | Public (Rate-limited) |
| `GET` | `/v1/stats` | Homepage counts and platform aggregates | Public |

For complete schemas, request/response examples, and error envelope definitions, refer to:
- [`docs/SPEC.md`](file:///home/ankurgupta/skillapt-registry/docs/SPEC.md)
- [`docs/openapi.yaml`](file:///home/ankurgupta/skillapt-registry/docs/openapi.yaml)

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

### 2. Provision Cloudflare D1 Database
```bash
npx wrangler d1 create skillapt-db
```
Copy the generated `database_id` into [`wrangler.jsonc`](file:///home/ankurgupta/skillapt-registry/wrangler.jsonc).

### 3. Provision Cloudflare R2 Storage Bucket
```bash
npx wrangler r2 bucket create skillapt-packages
```

### 4. Run Production Database Migrations
```bash
npx wrangler d1 migrations apply DB --remote
```

### 5. Configure Cloudflare Secrets
Never commit secrets to git. Inject them securely via Wrangler:
```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

### 6. Deploy the Worker
```bash
pnpm deploy
```
Your `skillapt` registry worker is now live at edge nodes worldwide!

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

### 3. Generate a CLI Token (Authenticated)
```bash
curl -s -X POST "http://localhost:8787/v1/tokens" \
  -H "Authorization: Bearer apt_live_testtoken1234567890abcdef" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-workstation"}' | jq .
```

### 4. Publish a Skill Package
```bash
curl -X POST "http://localhost:8787/v1/skills" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -F "file=@my-agent-skill.tar.gz"
```

### 5. Download a Package Tarball
```bash
curl -s -O -J "http://localhost:8787/v1/skills/pdf-summarizer/-/1.2.0.tgz"
```

---

## License

MIT © 2026 Skillapt Team
