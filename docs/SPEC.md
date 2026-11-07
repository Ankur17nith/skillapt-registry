# Skillapt Registry Specification

> **Version**: 1.0.0  
> **Status**: Ready for Implementation  
> **Target Platform**: Cloudflare Workers (TypeScript, Hono, D1, R2)  
> **Branding Rule**: The product name lives in exactly one constant: `PRODUCT_NAME = "skillapt"` in `src/config.ts`.

---

## 1. Overview & Vision

`skillapt` is a dedicated, secure package manager and package registry built specifically for **AI agent skills**. 

An **agent skill** is a modular package that teaches an AI agent (such as Claude, Cursor, Codex, Antigravity, or custom LLM systems) how to perform specialized tasks. Skills provide prompts, templates, schemas, and helper scripts that agents consume to accomplish workflows like summarizing documents, querying databases, generating code, or auditing security.

`skillapt` is **completely independent of npm**. It does not use npm packages, npm registries, `node_modules`, or npm scripts. It provides a lightweight, sandboxed distribution format tailored for agentic AI architectures.

### Core Architecture Principles
1. **Zero Code Execution on Registry**: The registry never executes, builds, runs, or evals any user code. Packages are inspected statically and served as static tarballs.
2. **Immutable Releases**: Once published, a version's tarball and metadata are frozen forever. A published version can never be overwritten or silently altered.
3. **Explicit Permissions**: Every skill explicitly declares what resources it needs (network, shell, filesystem). Agents and users know the permission footprint before installation.
4. **Resilient Dependency Resolution**: Semantic Versioning (SemVer 2.0.0) resolution skipping yanked versions, backed by deterministic lockfiles with SHA-256 integrity checks.
5. **Edge-Native Performance**: Powered by Cloudflare Workers (compute at the edge), Cloudflare D1 (SQLite database for relations and searches), and Cloudflare R2 (S3-compatible object storage for tarballs).

---

## 2. Package Format & Archive Rules

Every skill package is packaged as a standard gzip-compressed tar archive (`.tar.gz` or `.tgz`).

### 2.1 Archive Structure

Inside the archive root directory, the package MUST contain:

```text
my-skill/
├── skill.json       # Required: Package manifest
├── SKILL.md         # Required: Agent documentation and prompt guide
└── ...              # Optional: Helper templates, prompts, scripts, data
```

> **Note on root prefix**: Like standard tar archives, files MAY be placed in a top-level root folder matching the package name (e.g. `my-skill/skill.json`) or at the archive root (`skill.json`). The registry unpacker normalizes both structures safely.

### 2.2 Allowed File Types

To protect agent environments and prevent malicious payloads, only safe text, prompt, template, data, and script formats are permitted:

| Category | Allowed File Extensions |
| :--- | :--- |
| **Documentation & Prompts** | `.md`, `.txt`, `.prompt`, `.rst` |
| **Data & Configuration** | `.json`, `.yaml`, `.yml`, `.toml`, `.csv`, `.tsv` |
| **Templates** | `.jinja`, `.jinja2`, `.mustache`, `.hbs`, `.template` |
| **Common Scripts** | `.js`, `.mjs`, `.cjs`, `.ts`, `.py`, `.sh`, `.bash`, `.zsh`, `.lua`, `.rb` |
| **Allowed Dotfiles** | `.gitignore`, `.editorconfig` |

**Strictly Prohibited**:
- Executable binaries and shared libraries (`.exe`, `.dll`, `.so`, `.dylib`, `.bin`, `.app`, `.dmg`, etc.)
- Archive recursion (`.tar`, `.gz`, `.zip`, `.rar`, `.7z` inside the tarball)
- Hidden files or directories other than `.gitignore` and `.editorconfig` (e.g., no `.git/`, `.env`, `.DS_Store`)

### 2.3 Archive Size & Safety Limits

| Constraint | Limit | Description |
| :--- | :--- | :--- |
| **Compressed Upload Size** | **5 MB** (5,242,880 bytes) | Maximum allowable multipart payload for `.tar.gz`. |
| **Uncompressed Size** | **25 MB** (26,214,400 bytes) | Prevents decompression bombs (zip bombs). |
| **Max File Count** | **500 files** | Prevents inode exhaustion. |
| **Max File Path Length** | **255 characters** | Prevents buffer overflows and path truncation issues. |

### 2.4 Path Security & Traversal Prevention

During tar inspection, every file entry MUST satisfy:
- **No Path Traversal**: Cannot contain `..` path segments.
- **No Absolute Paths**: Cannot start with `/`, `\`, or Windows drive letters (e.g. `C:`).
- **No Symlinks or Hardlinks**: Tar entry header type flag MUST be regular file (`0` or `\0`) or directory (`5`). Links, block devices, character devices, and FIFOs are immediately rejected.
- **Clean Unicode**: Path names must be valid UTF-8 without null bytes (`\0`) or control characters.

---

## 3. Package Manifest (`skill.json`)

The manifest `skill.json` defines package metadata, agent runtime compatibility, permissions, and dependencies.

### 3.1 JSON Schema Definition

```json
{
  "name": "pdf-summarizer",
  "version": "1.2.0",
  "description": "Extracts text from PDF documents and generates structured agent summaries.",
  "license": "MIT",
  "repository": "https://github.com/agent-skills/pdf-summarizer",
  "keywords": ["pdf", "summarizer", "documents", "extraction"],
  "category": "documents",
  "compatibility": ["claude", "cursor", "codex", "antigravity"],
  "dependencies": {
    "text-cleaner": "^1.0.0"
  },
  "permissions": {
    "network": false,
    "shell": false,
    "filesystem": "read"
  }
}
```

### 3.2 Field Specifications

| Field | Type | Required | Rules & Validation |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Yes** | 3 to 50 characters. Lowercase letters (`a-z`), digits (`0-9`), and hyphens (`-`). Cannot start or end with a hyphen. May optionally have a scope prefix: `@<scope>/<name>`, where scope is 2 to 30 lowercase alphanumeric characters/hyphens. Regex: `^(@[a-z0-9-]{2,30}\/)?[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$` |
| `version` | `string` | **Yes** | Valid Semantic Versioning 2.0.0 (e.g., `1.0.0`, `1.2.3-alpha.1`). Must satisfy standard strict semver regex. |
| `description` | `string` | **Yes** | 10 to 300 characters. Plain text describing the skill. |
| `license` | `string` | **Yes** | Valid SPDX license identifier (e.g. `MIT`, `Apache-2.0`, `ISC`, `BSD-3-Clause`) or `UNLICENSED`. 1 to 50 characters. |
| `repository` | `string` | No | Valid HTTP/HTTPS repository URL (e.g., `https://github.com/user/repo`). Max 255 characters. |
| `keywords` | `string[]` | No | Up to 10 strings. Each keyword must be 2 to 30 lowercase alphanumeric characters and hyphens. |
| `category` | `string` | **Yes** | One of: `documents`, `coding`, `research`, `data`, `devtools`, `communication`, `productivity`, `other`. |
| `compatibility`| `string[]` | **Yes** | At least one item. Recognized platforms: `claude`, `cursor`, `codex`, `antigravity`, `openai`, `custom`. Max 20 items. |
| `dependencies` | `object` | No | Key-value mapping where key is a skill package name and value is a valid SemVer range (e.g. `^1.0.0`, `~2.1.0`, `>=1.0.0 <2.0.0`, `1.2.3`). Maximum 50 dependencies. |
| `permissions` | `object` | **Yes** | Object declaring capability requirements: <br>• `network`: `boolean`<br>• `shell`: `boolean`<br>• `filesystem`: `"none"` \| `"read"` \| `"write"` \| `"read-write"` |

---

## 4. Name Ownership & Immutability Rules

### 4.1 First Publisher Ownership
- The first user to publish a package name becomes the **owner** of that package.
- If a package is scoped (e.g., `@acme/summarizer`), the scope `@acme` belongs to the user or organization that first claimed it.
- Subsequent versions of the package can ONLY be published by the package owner or authorized maintainers.

### 4.2 Version Immutability
- Once published, version `X.Y.Z` of a package is **strictly immutable**.
- The tarball content, SHA-256 hash, and manifest metadata cannot be edited, swapped, or overwritten.
- Attempting to re-publish an existing version results in a `409 CONFLICT` error.
- To make updates, authors must increment the version according to SemVer (e.g., `1.0.1` or `1.1.0`).

### 4.3 Yank Behavior
- The package owner can **yank** a version (`POST /v1/skills/:name/:version/yank`).
- **What Yanking Does**:
  - Sets `yanked: true` in the database.
  - The version is **excluded** from automatic SemVer range queries (e.g. `skillapt install pdf-summarizer` or resolution for `^1.0.0` will ignore yanked `1.0.1` and pick `1.0.0`).
  - Search indexes deprioritize or flag yanked versions.
- **What Yanking Does NOT Do**:
  - It does NOT delete the tarball from R2.
  - It does NOT break existing builds or existing lockfiles. Anyone requesting the exact version directly (e.g. `GET /v1/skills/:name/-/:version.tgz` or explicit pinned version `1.0.1`) can still download it.
- **Un-yanking**: Owners may un-yank a version if a mistake was made, returning it to standard resolution.

---

## 5. Tarball Integrity & Lockfile Specification

### 5.1 Tarball Checksum (Integrity)
- Upon publication, the registry calculates the **SHA-256** cryptographic digest of the received tarball bytes:
  $$\text{sha256} = \text{hex}(\text{SHA-256}(\text{tarball\_bytes}))$$
- The hash is stored in the D1 database alongside package metadata.
- When an agent or CLI downloads a package, it MUST verify that:
  $$\text{SHA-256}(\text{downloaded\_bytes}) == \text{expected\_sha256}$$
  If the hash does not match, the installation fails immediately with an integrity mismatch error.

### 5.2 Lockfile Format (`skillapt-lock.json`)

The CLI maintains a deterministic lockfile in the consumer repository root:

```json
{
  "lockfileVersion": 1,
  "skills": {
    "pdf-summarizer": {
      "version": "1.2.0",
      "resolved": "https://registry.skillapt.dev/v1/skills/pdf-summarizer/-/1.2.0.tgz",
      "integrity": "sha256-a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0",
      "category": "documents",
      "permissions": {
        "network": false,
        "shell": false,
        "filesystem": "read"
      },
      "dependencies": {
        "text-cleaner": "^1.0.0"
      }
    },
    "text-cleaner": {
      "version": "1.0.2",
      "resolved": "https://registry.skillapt.dev/v1/skills/text-cleaner/-/1.0.2.tgz",
      "integrity": "sha256-def0123456789abcdef0123456789abcdef0123456789abcdef0123456789abc",
      "category": "data",
      "permissions": {
        "network": false,
        "shell": false,
        "filesystem": "none"
      },
      "dependencies": {}
    }
  }
}
```

---

## 6. Authentication & Authorization Model

The registry supports two authentication mechanisms:
1. **Browser Sessions**: For the web UI via secure, HTTP-only cookies.
2. **API Bearer Tokens**: For the CLI tool via personal access tokens.

### 6.1 GitHub OAuth 2.0 Web Flow

```
User (Browser)               Skillapt Registry               GitHub OAuth
     |                               |                            |
     |--- 1. GET /v1/auth/github --->|                            |
     |                               |-- 2. Redirect to GitHub -->|
     |<-- 3. 302 to GitHub Auth -----|                            |
     |                                                            |
     |--- 4. Authorize App on GitHub ---------------------------->|
     |<-- 5. Redirect to /v1/auth/github/callback?code=... -------|
     |                               |                            |
     |--- 6. Callback with code ---->|-- 7. Exchange code ------->|
     |                               |<-- 8. Access token --------|
     |                               |-- 9. Fetch user profile -->|
     |                               |<-- 10. User data ----------|
     |                               |                            |
     |                               | [Create/Update User in D1] |
     |                               | [Create Web Session]       |
     |<-- 11. Set-Cookie: session ---|                            |
     |        Redirect to Web UI     |                            |
```

- **State Parameter**: Signed or random crypto-state stored in temporary cookie to prevent CSRF attacks.
- **Session Cookie Attributes**:
  - `Name`: `skillapt_session`
  - `HttpOnly`: `true` (unreadable via clientside JavaScript)
  - `Secure`: `true` (HTTPS only, relaxed for localhost during testing)
  - `SameSite`: `Lax`
  - `Max-Age`: 30 days (2,592,000 seconds)
  - `Path`: `/`

### 6.2 CLI API Tokens (Bearer Auth)

For automated usage and CLI publishing:
- Authenticated users create tokens via `POST /v1/tokens`.
- **Raw Token Format**: `apt_live_` followed by 32 cryptographically random bytes (hex or url-safe base64), e.g. `apt_live_9f83a4c102b8d93e7f6201a4e5c891b2`.
- **Storage Rule**: The raw token is **never** saved in the database. Only the **SHA-256** hash is stored:
  $$\text{token\_hash} = \text{hex}(\text{SHA-256}(\text{raw\_token}))$$
- **Display Rule**: The raw token is displayed **exactly once** in the response to `POST /v1/tokens`. It cannot be retrieved again.
- **Verification**: The incoming `Authorization: Bearer <token>` header is hashed with SHA-256 and matched against the `token_hash` column in D1 SQLite.
- **Revocation**: Users can list active tokens (`GET /v1/tokens`) and delete any token by ID (`DELETE /v1/tokens/:id`).

---

## 7. Error Handling Standard

All endpoints return errors in a uniform JSON envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description of what went wrong."
  }
}
```

### Standard Error Codes

| HTTP Status | Error Code | Meaning / Scenario |
| :--- | :--- | :--- |
| `400` | `BAD_REQUEST` | Malformed JSON, missing required query/body fields. |
| `400` | `INVALID_PACKAGE` | Manifest fails Zod validation, missing SKILL.md, or invalid files. |
| `400` | `INVALID_NAME` | Package name violates naming syntax. |
| `400` | `INVALID_VERSION` | Version is not valid SemVer 2.0.0. |
| `401` | `UNAUTHORIZED` | Missing or invalid authentication token/session. |
| `403` | `FORBIDDEN` | Caller does not own the package or maintainer permissions. |
| `404` | `NOT_FOUND` | Skill, version, or user resource does not exist. |
| `409` | `CONFLICT` | Version already exists (immutable) or name collision. |
| `413` | `PAYLOAD_TOO_LARGE` | Uploaded tarball exceeds 5 MB. |
| `429` | `RATE_LIMITED` | Too many requests; rate limit threshold exceeded. |
| `500` | `INTERNAL_ERROR` | Unexpected server error. |

---

## 8. Rate Limits & Security Policies

### 8.1 Rate Limits

Cloudflare Worker KV or in-memory sliding window counters enforce rate limits:

| Endpoint | Target | Limit | Window |
| :--- | :--- | :--- | :--- |
| `GET /v1/skills` | Client IP | 60 requests | 1 minute |
| `POST /v1/skills` (publish) | User Account | 10 publishes | 1 hour |
| `POST /v1/reports` | Client IP | 5 reports | 1 hour |
| `POST /v1/tokens` | User Account | 10 creations | 1 day |

When rate-limited, the API responds with:
- HTTP Status: `429 Too Many Requests`
- Headers: `Retry-After: <seconds>`
- Body: `{"error": {"code": "RATE_LIMITED", "message": "Rate limit exceeded. Please try again later."}}`

### 8.2 CORS & Origin Protections
- Allowed origins are restricted to official website domains (e.g. `https://skillapt.dev`, `https://www.skillapt.dev`) and `http://localhost:3000` / `http://localhost:5173` in local development.
- Unauthenticated read endpoints (`GET /skills`, `GET /stats`) permit CORS `GET` for easy web integration.
- Destructive and state-changing routes (`POST`, `DELETE`) require explicit Origin validation or Bearer tokens.

### 8.3 Secrets Management
- No secrets are stored in code or git repositories.
- Cloudflare secrets are injected via `wrangler secret put` or local `.dev.vars` (strictly gitignored).
- Required secrets:
  - `GITHUB_CLIENT_ID`
  - `GITHUB_CLIENT_SECRET`
  - `SESSION_SECRET` (used for cookie signing)

---

## 9. API Endpoint Reference

All registry endpoints are prefixed with `/v1`.

### 9.1 Discovery & Search

#### `GET /v1/skills`
Search and list packages with filtering, sorting, and pagination.

- **Query Parameters**:
  - `q` (string, optional): Search query matching name, description, or keywords.
  - `category` (string, optional): Filter by category (e.g. `documents`).
  - `compat` (string, optional): Filter by compatibility runtime (e.g. `claude`).
  - `verified` (boolean, optional): Filter by verified publisher status (`true` / `false`).
  - `sort` (string, optional): Sorting criteria: `downloads` (default), `recent`, `name`.
  - `page` (integer, optional): Page number (default: `1`).
  - `limit` (integer, optional): Items per page (default: `20`, max: `100`).

- **Response `200 OK`**:
```json
{
  "skills": [
    {
      "name": "pdf-summarizer",
      "latestVersion": "1.2.0",
      "description": "Extracts text from PDF documents and generates structured agent summaries.",
      "license": "MIT",
      "category": "documents",
      "compatibility": ["claude", "cursor", "codex"],
      "downloads": 1420,
      "verified": true,
      "owner": {
        "handle": "alexdev",
        "avatarUrl": "https://avatars.githubusercontent.com/u/12345"
      },
      "updatedAt": "2026-11-01T12:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

---

#### `GET /v1/skills/:name`
Retrieve full metadata for a package, including its latest release, owner, and all available versions.

- **Path Parameters**:
  - `:name` (string): Package name (URL-encoded if scoped, e.g. `%40team%2Fmy-skill` or `@team/my-skill`).

- **Response `200 OK`**:
```json
{
  "name": "pdf-summarizer",
  "description": "Extracts text from PDF documents and generates structured agent summaries.",
  "license": "MIT",
  "repository": "https://github.com/agent-skills/pdf-summarizer",
  "keywords": ["pdf", "summarizer", "documents"],
  "category": "documents",
  "compatibility": ["claude", "cursor", "codex"],
  "owner": {
    "handle": "alexdev",
    "avatarUrl": "https://avatars.githubusercontent.com/u/12345"
  },
  "latestVersion": "1.2.0",
  "downloads": 1420,
  "versions": {
    "1.2.0": {
      "version": "1.2.0",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "size": 14250,
      "tarballUrl": "https://registry.skillapt.dev/v1/skills/pdf-summarizer/-/1.2.0.tgz",
      "dependencies": {
        "text-cleaner": "^1.0.0"
      },
      "publishedAt": "2026-11-01T12:00:00Z",
      "yanked": false,
      "permissions": {
        "network": false,
        "shell": false,
        "filesystem": "read"
      }
    },
    "1.1.0": {
      "version": "1.1.0",
      "sha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
      "size": 13800,
      "tarballUrl": "https://registry.skillapt.dev/v1/skills/pdf-summarizer/-/1.1.0.tgz",
      "dependencies": {},
      "publishedAt": "2026-10-15T09:30:00Z",
      "yanked": false,
      "permissions": {
        "network": false,
        "shell": false,
        "filesystem": "read"
      }
    }
  },
  "readme": "# PDF Summarizer\n\nExtracts text and summarizes...",
  "createdAt": "2026-10-15T09:30:00Z",
  "updatedAt": "2026-11-01T12:00:00Z"
}
```

- **Error `404 Not Found`**:
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Skill 'pdf-summarizer' does not exist."
  }
}
```

---

#### `GET /v1/skills/:name/:version`
Retrieve specific version metadata for dependency resolution and lockfile population.

- **Path Parameters**:
  - `:name`: Package name
  - `:version`: Exact SemVer string (e.g. `1.2.0`)

- **Response `200 OK`**:
```json
{
  "name": "pdf-summarizer",
  "version": "1.2.0",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 14250,
  "tarballUrl": "https://registry.skillapt.dev/v1/skills/pdf-summarizer/-/1.2.0.tgz",
  "dependencies": {
    "text-cleaner": "^1.0.0"
  },
  "publishedAt": "2026-11-01T12:00:00Z",
  "yanked": false,
  "permissions": {
    "network": false,
    "shell": false,
    "filesystem": "read"
  }
}
```

---

#### `GET /v1/skills/:name/-/:version.tgz`
Download the raw package tarball.

- **Path Parameters**:
  - `:name`: Package name
  - `:version`: Exact SemVer string (without `.tgz`)
- **Headers Returned**:
  - `Content-Type`: `application/gzip`
  - `Content-Disposition`: `attachment; filename="pdf-summarizer-1.2.0.tgz"`
  - `ETag`: `"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"`
  - `Cache-Control`: `public, max-age=31536000, immutable`
- **Response**: Binary stream of the `.tar.gz` archive.

---

### 9.2 Publishing & Version Management

#### `POST /v1/skills`
Publish a new package or a new version of an existing package.

- **Authentication**: Required (`Authorization: Bearer <token>` or active session cookie).
- **Request Format**: `multipart/form-data`
  - `file`: The `.tar.gz` file payload (max 5 MB).
- **Validation Pipeline**:
  1. Inspect multipart payload and check file size $\le$ 5 MB.
  2. Stream tar archive; verify no zip-bombs, no symlinks, no traversal paths, no banned file types.
  3. Extract and parse `skill.json`; validate with Zod against manifest schema.
  4. Verify that `SKILL.md` is present and non-empty.
  5. Check name ownership: if package exists in D1, verify caller is owner or maintainer.
  6. Check immutability: verify version does not already exist in D1.
  7. Compute SHA-256 hash.
  8. Write tarball to Cloudflare R2 bucket at `skills/:name/:version.tgz`.
  9. Insert records into D1 SQLite (`skills`, `skill_versions`, `dependencies`).

- **Response `201 Created`**:
```json
{
  "name": "pdf-summarizer",
  "version": "1.2.0",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 14250,
  "tarballUrl": "https://registry.skillapt.dev/v1/skills/pdf-summarizer/-/1.2.0.tgz",
  "message": "Successfully published pdf-summarizer@1.2.0"
}
```

- **Error `409 Conflict`**:
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Version 1.2.0 for skill 'pdf-summarizer' has already been published and is immutable."
  }
}
```

---

#### `POST /v1/skills/:name/:version/yank`
Yank a specific version from search and resolution.

- **Authentication**: Required (must be package owner).
- **Request Body** (optional):
```json
{
  "reason": "Critical vulnerability detected in parsing routine."
}
```
- **Response `200 OK`**:
```json
{
  "name": "pdf-summarizer",
  "version": "1.2.0",
  "yanked": true,
  "message": "Version 1.2.0 has been yanked."
}
```

---

### 9.3 Authentication & Tokens

#### `GET /v1/auth/github`
Initiates GitHub OAuth flow.
- Redirects browser to `https://github.com/login/oauth/authorize?client_id=...&state=...&scope=read:user,user:email`.

#### `GET /v1/auth/github/callback`
GitHub OAuth callback handler.
- Exchanges authorization code for GitHub access token.
- Retrieves GitHub user details and primary verified email.
- Upserts user record in D1.
- Creates session in D1 and attaches HTTP-only cookie.
- Redirects browser to frontend dashboard (e.g. `/dashboard` or `/`).

#### `POST /v1/auth/logout`
Terminates current web session.
- **Authentication**: Session cookie.
- Clears session record in D1.
- Clears `skillapt_session` cookie (`Max-Age=0`).
- **Response `200 OK`**:
```json
{
  "message": "Successfully logged out."
}
```

#### `GET /v1/me`
Retrieves information about the currently authenticated user.
- **Authentication**: Required.
- **Response `200 OK`**:
```json
{
  "id": "usr_9a8b7c6d",
  "handle": "alexdev",
  "name": "Alex Rivers",
  "email": "alex@example.com",
  "avatarUrl": "https://avatars.githubusercontent.com/u/12345",
  "createdAt": "2026-09-01T10:00:00Z"
}
```

#### `GET /v1/tokens`
List active API tokens created by the authenticated user.
- **Authentication**: Required.
- **Response `200 OK`**:
```json
{
  "tokens": [
    {
      "id": "tok_1234abcd",
      "name": "cli-laptop",
      "prefix": "apt_live_9f83",
      "createdAt": "2026-10-01T15:00:00Z",
      "lastUsedAt": "2026-11-06T18:22:10Z"
    }
  ]
}
```

#### `POST /v1/tokens`
Generate a new API token for CLI authentication.
- **Authentication**: Required.
- **Request Body**:
```json
{
  "name": "cli-workstation"
}
```
- **Response `201 Created`**:
```json
{
  "id": "tok_5678efgh",
  "name": "cli-workstation",
  "token": "apt_live_a1b2c3d4e5f67890123456789abcdef0",
  "createdAt": "2026-11-07T10:00:00Z",
  "warning": "Copy this token now. It will not be shown again."
}
```

#### `DELETE /v1/tokens/:id`
Revoke an API token.
- **Authentication**: Required.
- **Response `200 OK`**:
```json
{
  "message": "Token successfully revoked."
}
```

---

### 9.4 Community & Statistics

#### `POST /v1/reports`
Submit an abuse or security report against a skill.
- **Authentication**: Public (rate limited to 5 requests / hour per IP).
- **Request Body**:
```json
{
  "skillName": "pdf-summarizer",
  "version": "1.2.0",
  "reason": "malware",
  "details": "Attempts to send local API keys to remote endpoint without permission."
}
```
- **Response `201 Created`**:
```json
{
  "id": "rep_99182",
  "message": "Report received and queued for review. Thank you for keeping the registry safe."
}
```

#### `GET /v1/stats`
Platform aggregates for the homepage.
- **Authentication**: Public.
- **Response `200 OK`**:
```json
{
  "totalSkills": 1250,
  "totalVersions": 4820,
  "totalDownloads": 354920,
  "totalAuthors": 412
}
```

---

## 10. Summary of Requirements & Next Steps

This specification governs all database tables, validations, APIs, and client interactions. Both the `skillapt` CLI and web UI are designed to interact directly with the contracts defined here and in `docs/openapi.yaml`.
