# Skillapt Registry Specification

> **Version**: 1.1.0  
> **Status**: Approved Specification for Registry, CLI, and Web UI  
> **Target Platform**: Cloudflare Workers (TypeScript, Hono, D1 SQLite, R2 Object Storage)  
> **Branding Rule**: The product name lives in exactly one constant: `PRODUCT_NAME = "skillapt"` in `src/config.ts`.

---

## 1. Overview & Vision

`skillapt` is an independent, secure package manager and package registry built specifically for **AI agent skills**.

An **agent skill** is a modular package that teaches an AI agent (such as Claude, Cursor, Codex, Antigravity, or custom LLM frameworks) how to perform specialized tasks. Skills provide instructions, prompt templates, schemas, and helper scripts that agents consume to accomplish workflows like document summarization, database queries, code refactoring, or security auditing.

`skillapt` provides a lightweight, sandboxed distribution format tailored for modern agentic AI architectures without relying on npm runtimes or lifecycle execution scripts.

### Core Architecture Principles
1. **Zero Code Execution on Registry**: The registry never executes, builds, runs, or evaluates user code. Packages are inspected statically and served as static tarballs.
2. **Immutable Releases & Atomicity**: Once published, a version's tarball and metadata are frozen forever. Releases are atomic: tarball storage and database records are synchronized with complete rollback on failure. Build metadata (`+...`) is strictly rejected.
3. **Explicit Declarations**: Every skill declares its permissions (network, shell, filesystem). These are declarations for user and agent awareness, not kernel-level enforcements.
4. **Deterministic Resolution**: Semantic Versioning (SemVer 2.0.0) resolution skipping yanked and removed versions, backed by deterministic lockfiles (`skills.lock.json`) with standard `integrity` (`sha256-<hex>`) hashes. Flat installs prevent dependency hell.
5. **Edge-Native Performance**: Powered by Cloudflare Workers (compute at the edge), Cloudflare D1 (relational metadata), Cloudflare R2 (immutable tarball storage), and Cloudflare native Rate Limiting.

---

## 2. Threat Model & Security Posture

AI agent skill packages introduce threat vectors distinct from traditional software dependencies. Because skills are interpreted by Large Language Models and agent runtimes, security requires clear boundaries and defense-in-depth.

### 2.1 Threat Vectors

| Threat | Description | Registry Mitigation | Runtime / Client Mitigation |
| :--- | :--- | :--- | :--- |
| **Prompt Injection** | Adversarial instructions hidden inside `SKILL.md` or templates designed to hijack agent system prompts, leak system contexts, or bypass agent guardrails. | Static text inspection, UTF-8 normalization, required standard YAML frontmatter, community abuse reporting (`POST /v1/reports`). | Agents must treat unverified skill documentation as untrusted user input, isolate system instructions, and enforce prompt delimiters. |
| **Malicious Scripts** | Executable shell, Python, or JavaScript scripts designed to steal environment keys (`.env`, AWS/OpenAI tokens) or execute system commands. | Strict ban on binary executables (`.exe`, ELF, Mach-O, `.dll`, `.so`). Explicit permission declaration required in `skill.json`. Static extension and file structure validation. | Agent environments must run helper scripts inside ephemeral sandboxes (e.g. gVisor, Docker, WebAssembly) with restricted permissions. |
| **Permission Under-declaration** | A skill declares `network: false` but its script attempts socket connections. | Declarations are verified against community reports; false declarations result in immediate admin takedown (`removed` status). | Runtimes must enforce declared permissions via OS sandbox profiles rather than relying on trust. |
| **Typosquatting & Impersonation** | Registering names resembling popular skills (e.g., `pdf-summarizer` vs `pdf-summarizerr`) or impersonating official vendor packages. | Reserved names list (`skillapt`, `admin`, `claude`, `openai`, etc.), strict GitHub-scoped ownership (`@handle/name`), verified badges for authenticated repositories, and typosquat reporting. | CLI warns on newly published packages and flags unverified publishers. |
| **Decompression Bombs (Zip Bombs)** | Small `.tar.gz` archives expanding into hundreds of gigabytes to exhaust memory or disk space. | Strict upload limit (5 MB compressed) and **streaming decompression aborting at 25 MB** before memory allocation. Maximum 500 files. | CLI applies identical streaming decompression limits locally before unpacking. |
| **Path Traversal & Overwrite** | Tar archives containing `../`, absolute paths, symlinks, or duplicate filenames attempting to overwrite critical host files. | Tarball parser strictly forbids `..`, absolute paths, Windows drive letters, symlinks, hardlinks, and duplicate paths. | CLI validates all paths prior to writing to the project skills directory. |

### 2.2 Permissions Are Declarations, Not Enforcement
> [!IMPORTANT]
> The `permissions` object in `skill.json` represents the author's **declared capability requirements**. The registry verifies that the declaration is well-formed, but the registry **does not and cannot enforce runtime constraints** during agent execution. Client CLI tools, IDE plugins, and agent hosts are responsible for reading `permissions` and configuring sandboxed environments (e.g. disabling container networking if `network: false`).

---

## 3. Package Format & Archive Rules

Every skill package is distributed as a gzip-compressed tar archive (`.tar.gz` or `.tgz`).

### 3.1 Archive Layout

```text
<package-name>/               # Optional root directory (normalized automatically)
├── skill.json                # Required: Package manifest
├── SKILL.md                  # Required: Agent documentation with standard YAML frontmatter
└── ...                       # Optional: Prompts, templates, schemas, and helper scripts
```

### 3.2 Required Files & Specifications

#### 1. `SKILL.md` (Agent Skills Open Standard)
`SKILL.md` is the primary interface between the package and the consuming AI agent. It **MUST** begin with valid YAML frontmatter demarcated by triple dashes (`---`).

- **Required Frontmatter Keys**:
  - `name`: Must match the **unscoped** package name specified in `skill.json` (e.g. for package `@alice/pdf-tool`, frontmatter `name` must be `pdf-tool`).
  - `description`: A clear, single-sentence summary of what the skill enables for the agent.
- **Content Limits**:
  - Minimum size: 10 non-whitespace characters.
  - Maximum size: 256 KB (262,144 bytes). Prevents context-window flooding and D1 database bloat.
- **Example `SKILL.md`**:
```markdown
---
name: pdf-summarizer
description: Extracts text from PDF files and generates structured summaries.
category: documents
version: 1.2.0
---

# PDF Summarizer Skill

## Capabilities
- Extracts raw text and metadata from PDF files up to 50 MB.
- Generates section-by-section summaries formatted in GitHub Markdown.

## Usage Guidelines
When the user asks to summarize a PDF, inspect the document outline first...
```

#### 2. `skill.json` (Package Manifest)
The authoring manifest defining metadata, dependencies, and capabilities. Detailed schema is defined in [Section 4](#4-package-manifest-skilljson).

### 3.3 Allowed File Types & Content Verification

The registry inspects all entries in the tarball. Only safe, text-based, template, and script formats are allowed:

| Category | Allowed File Extensions |
| :--- | :--- |
| **Documentation & Prompts** | `.md`, `.txt`, `.prompt`, `.rst` |
| **Data & Configuration** | `.json`, `.yaml`, `.yml`, `.toml`, `.csv`, `.tsv`, `.xml`, `.xsd` |
| **Web Assets** | `.html`, `.css`, `.svg` |
| **Templates** | `.jinja`, `.jinja2`, `.mustache`, `.hbs`, `.template` |
| **Common Scripts** | `.js`, `.mjs`, `.cjs`, `.ts`, `.py`, `.sh`, `.bash`, `.zsh`, `.lua`, `.rb` |
| **Allowed Special Dotfiles** | `.gitignore`, `.editorconfig` |
| **Allowed Extensionless Files** | `LICENSE`, `NOTICE`, `README`, `CHANGELOG`, `Makefile` |

**Strictly Prohibited & Rejected**:
- **Binary Executables & Libraries**: `.exe`, `.dll`, `.so`, `.dylib`, `.bin`, `.elf`, `.macho`, `.com`.
- **Content Signature Checking**: The registry inspects the initial 512 bytes of every file. Any file matching ELF (`0x7F 0x45 0x4C 0x46`), Mach-O (`0xFE 0xED 0xFA 0xCE/CF` or `0xCF 0xFA 0xED 0xFE` or universal fat binary `0xCA 0xFE 0xBA 0xBE`), Windows PE (`MZ` / `0x4D 0x5A`), Java class, or WebAssembly (`\0asm` / `0x00 0x61 0x73 0x6D`) magic bytes is **rejected immediately**, even if disguised with a `.py` or `.txt` extension.
- **Nested Archives**: `.tar`, `.gz`, `.zip`, `.rar`, `.7z`, `.bz2`.
- **Hidden Files & Directories**: Any file or directory with any path segment starting with `.` other than `.gitignore` and `.editorconfig`.

### 3.4 Archive Safety Constraints & Streaming Limits

| Constraint | Limit | Implementation Requirement |
| :--- | :--- | :--- |
| **Compressed Upload Limit** | **5 MB** (5,242,880 bytes) | Enforced via HTTP `Content-Length` and multipart body stream. |
| **Uncompressed Total Limit** | **25 MB** (26,214,400 bytes) | **Enforced strictly WHILE streaming** through `DecompressionStream("gzip")`. The reader aborts immediately when cumulative chunk bytes exceed 25 MB. Never buffered into memory. |
| **Max File Count** | **500 entries** | Aborts parsing if file count exceeds 500. |
| **Max Path Length** | **255 characters** | Rejects entries with path length > 255. |
| **Path Traversal (`..`)** | Forbidden | Any entry containing `..` as a path segment is rejected. |
| **Absolute Paths** | Forbidden | Any path starting with `/`, `\`, or Windows drive letters (e.g. `C:`) is rejected. |
| **Duplicate Paths** | Forbidden | The unpacker maintains a set of seen paths. Duplicate paths (including case-insensitive and Unicode NFC collisions) trigger immediate rejection. |
| **Unicode Normalization** | NFC Required | Paths are normalized via UTF-8 NFC. Collisions between decomposed and precomposed representations are blocked. |
| **Header Types** | Regular/Dir Only | Type flags other than `'0'` (regular file), `'\0'`, and `'5'` (directory) are rejected (symlinks `'2'`, hardlinks `'1'`, devices `'3'`/`'4'`/`'6'` are blocked). PAX (`'x'`, `'g'`) and GNU (`'L'`, `'K'`) headers are safely handled as metadata or rejected if malformed. |

---

## 4. Package Manifest (`skill.json`)

The package manifest lives inside the archive root and governs package distribution.

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

### 4.1 Field Rules & Validation Matrix

| Field | Type | Required | Specification & Validation Rules |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Yes** | 3 to 50 characters. Lowercase letters (`a-z`), digits (`0-9`), and hyphens (`-`). Cannot start or end with a hyphen. May optionally have a scope prefix: `@<handle>/<name>`. Regex: `^(@[a-z0-9-]{2,30}\/)?[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`. Must not be in the [Reserved Names](#53-reserved-names-list) list. |
| `version` | `string` | **Yes** | Strict Semantic Versioning 2.0.0 (e.g. `1.0.0`, `2.1.0-beta.1`). **Build metadata (`+...`) is strictly rejected** to ensure release immutability and unambiguous version precedence. |
| `description` | `string` | **Yes** | 10 to 300 characters. Plain text summary. |
| `license` | `string` | **Yes** | Valid SPDX license identifier (e.g. `MIT`, `Apache-2.0`, `ISC`) or `UNLICENSED`. Max 50 characters. |
| `repository` | `string` | No | Valid HTTP/HTTPS repository URL (e.g. `https://github.com/org/repo`). Required for verified badge. |
| `keywords` | `string[]` | No | Up to 10 strings. Lowercase alphanumeric and hyphens, 2–30 chars each. |
| `category` | `string` | **Yes** | One of: `documents`, `coding`, `research`, `data`, `devtools`, `communication`, `productivity`, `other`. |
| `compatibility` | `string[]` | **Yes** | 1 to 20 strings. Valid targets: `claude`, `cursor`, `codex`, `antigravity`, `openai`, `custom`. |
| `dependencies` | `object` | No | Key-value mapping of dependency skill name to valid SemVer range (e.g. `^1.0.0`, `~2.1.0`, `>=1.0.0 <2.0.0`). Max 50 dependencies. Every dependency must satisfy the [Dependency Rules](#7-dependency-resolution--install-model). |
| `permissions` | `object` | **Yes** | Capability declarations: <br>• `network`: `boolean`<br>• `shell`: `boolean`<br>• `filesystem`: `"none"` \| `"read"` \| `"write"` \| `"read-write"` |

---

## 5. Naming, Scopes, & Ownership

### 5.1 Scopes (`@handle/name`)
In `skillapt` v1, scopes are strictly bound to GitHub usernames and organization handles:
- A scoped package MUST follow the pattern `@<handle>/<name>`.
- The scope `@<handle>` matches the authenticated user's GitHub login handle (case-insensitive).
- **Enforcement**: Only user `@alice` can publish `@alice/my-skill`. An attempt by user `@bob` to publish under `@alice/*` returns `403 FORBIDDEN`.
- Organization scopes: Allowed if the user is a verified public member or owner of that GitHub organization.

### 5.2 Unscoped Packages (First-Come, First-Served)
- Unscoped packages (e.g. `pdf-summarizer`) are owned by whichever authenticated user successfully publishes version 1 first.
- Subsequent releases of that unscoped package can only be published by that owner or designated maintainers.

### 5.3 Reserved Names List
The following names are strictly reserved by the registry and **cannot be registered** as unscoped packages:

```text
skillapt, admin, api, www, official, registry, support, security, root,
claude, openai, anthropic, cursor, codex, antigravity, gemini, chatgpt,
null, undefined, core, internal, system, auth, account, dashboard
```

Any attempt to publish a package using a reserved name returns `400 BAD_REQUEST` with code `RESERVED_NAME`.

### 5.4 Typosquatting & Impersonation Policy
Users may submit abuse reports via `POST /v1/reports` using the reason code `typosquat`. If an unscoped package closely resembles an existing high-reputation skill (evaluated via Levenshtein distance $\le 2$ or phonetics) without legitimate distinction, registry administrators will review and take down the offending package under the Admin Takedown procedure.

### 5.5 Verified Publisher Status (`verified: true`)
A package displays `verified: true` in metadata and search results if and only if:
1. The publisher account is authenticated via GitHub OAuth.
2. The `repository` field in `skill.json` points to a valid GitHub repository owned by the publisher's GitHub account or an organization where the publisher is a public member.
3. For scoped packages `@handle/name`, the handle directly matches the verified GitHub account.

---

## 6. Consumer Project Files (`skills.json` and `skills.lock.json`)

Consumer repositories (projects that consume skills for their AI agents) use standard JSON configuration files in the root directory.

### 6.1 Consumer Manifest (`skills.json`)
The consumer manifest declares the project's direct skill dependencies:

```json
{
  "name": "my-agent-workspace",
  "version": "1.0.0",
  "description": "Customer support AI agent configuration",
  "skills": {
    "pdf-summarizer": "^1.2.0",
    "@acme/ticket-classifier": "~2.0.0",
    "text-cleaner": "1.0.2"
  }
}
```

- `name`: Name of the consumer workspace (string).
- `skills`: Object mapping skill package name to required SemVer range.

### 6.2 Consumer Lockfile (`skills.lock.json`)
The lockfile guarantees deterministic, reproducible installations across developer workstations and CI/CD pipelines.

```json
{
  "lockfileVersion": 1,
  "skills": {
    "pdf-summarizer": {
      "version": "1.2.0",
      "resolved": "https://registry.skillapt.dev/v1/skills/pdf-summarizer/-/1.2.0.tgz",
      "integrity": "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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
      "integrity": "sha256-7d8312d8a427f71b9e0787389278918237abc091823481298471209348123049",
      "sha256": "7d8312d8a427f71b9e0787389278918237abc091823481298471209348123049",
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

### 6.3 Integrity Field Standard
- **Format**: `sha256-<hex-digest>` (e.g. `sha256-e3b0c442...`).
- Both `integrity` (`sha256-<hex>`) and `sha256` (`<hex>`) are returned by the registry API across all version endpoints and stored in `skills.lock.json`.
- The CLI MUST verify `SHA-256(tarball_bytes) === integrity` before unpacking. If the checksum does not match, the installation aborts with an integrity error.

---

## 7. Dependency Resolution & Install Model

`skillapt` employs a **flat dependency model** designed for agent prompt simplicity:

### 7.1 Rules & Constraints
1. **Publication-Time Validation**: Every dependency declared in `skill.json` MUST already exist in the registry at publish time and have at least one matching, non-removed (`active` or `yanked`) version satisfying the SemVer range. If a dependency cannot be satisfied, publish is rejected with `400 INVALID_DEPENDENCY`.
2. **Maximum Dependency Depth**: 10 levels. Transitive trees deeper than 10 levels fail resolution.
3. **No Cycles**: Dependency graphs must be Directed Acyclic Graphs (DAG). Any circular reference ($A \to B \to A$) causes an installation failure.
4. **Flat Installation (One Version Per Name)**: Because AI agents access skills by name in context windows, there are no nested `node_modules`. If two dependencies require conflicting versions of the same skill (e.g. `foo@1.0.0` vs `foo@2.0.0`), the CLI raises a **Version Conflict Error** requiring the user to resolve the conflict.

---

## 8. Version Lifecycle & Admin Takedown

Every skill version has a lifecycle state tracked in the `skill_versions.status` column:

```mermaid
stateDiagram-v2
    [*] --> active : Publish (atomic R2 + D1)
    active --> yanked : Owner Yanks Version
    yanked --> active : Owner Un-yanks Version
    active --> removed : Admin Takedown (Report / Malware)
    yanked --> removed : Admin Takedown
```

### 8.1 Status Definitions

| Status | Range Resolution | Direct Pinned Download | Metadata Visibility | HTTP Download Status |
| :--- | :--- | :--- | :--- | :--- |
| `active` | Included | Available | Full details | `200 OK` |
| `yanked` | **Excluded** | Available | Visible with `yanked: true` | `200 OK` |
| `removed` | **Excluded** | **Blocked** | Visible as `{ status: "removed", removed: true }` | **`410 Gone`** |

### 8.2 Yanking (`POST /v1/skills/:name/:version/yank` and `DELETE /v1/skills/:name/:version/yank`)
- Performed by the package owner.
- `POST /v1/skills/:name/:version/yank` is idempotent: it sets `yanked = true` and accepts an optional `reason` (max 500 characters). Subsequent POSTs are no-ops.
- `DELETE /v1/skills/:name/:version/yank` is idempotent: it clears `yanked = false` (un-yanks the version).
- Yanks hide the version from automatic range resolution, but pinned downloads continue to function for existing lockfiles.

### 8.3 Admin Takedowns (`status = "removed"`)
When a package is found to contain malware, prompt injection, or severe copyright violations:
1. The version status is updated to `removed` and linked to the originating `report_id`.
2. Tarball downloads (`GET /v1/skills/:name/-/:version.tgz`) return **`410 Gone`** with explanation and `Cache-Control: no-store`.
3. Metadata reflects `status: "removed"`, `removed: true`, `removalReason`, and omits the `tarballUrl`.
4. **Admin Routes**:
   - `POST /v1/admin/skills/:name/:version/takedown` (sets status to `removed`, logs to `audit_log`)
   - `POST /v1/admin/skills/:name/:version/restore` (restores status to `active` or `yanked`, logs to `audit_log`)
   - `GET /v1/admin/reports` (lists abuse reports)
   - `POST /v1/admin/reports/:id/resolve` (resolves report, logs to `audit_log`)
   - Authorization requires an authenticated user with `users.role = 'admin'` (Bearer token or session).
5. **Bootstrapping the First Admin**:
   To bootstrap an admin user in production:
   ```bash
   wrangler d1 execute DB --remote --command="UPDATE users SET role = 'admin' WHERE handle = '<handle>';"
   ```
6. **Direct D1 Procedure** (Emergency / Manual):
   ```sql
   UPDATE skill_versions 
   SET status = 'removed', removal_reason = 'Admin Takedown: Malware report rep_12345', removed_at = datetime('now')
   WHERE skill_name = 'malicious-skill' AND version = '1.0.0';
   ```

---

## 9. Publish Atomicity & Storage Integrity

To prevent orphaned files in R2 and inconsistent database states, the publication pipeline enforces atomic operations:

```mermaid
sequenceDiagram
    autonumber
    actor CLI as CLI / Publisher
    participant API as Registry API
    participant D1 as Cloudflare D1
    participant R2 as Cloudflare R2

    CLI->>API: POST /v1/skills (multipart .tar.gz)
    API->>API: 1. Validate stream (25MB uncompressed limit)
    API->>API: 2. Validate SKILL.md frontmatter & skill.json
    API->>API: 3. Verify permissions, reserved names & dependencies
    API->>D1: 4. Check ownership & version existence
    API->>API: 5. Compute SHA-256 hash & integrity string
    API->>R2: 6. Conditional put (onlyIf key does not exist)
    alt D1 Insert Succeeds
        API->>D1: 7. INSERT skills, skill_versions, dependencies
        API-->>CLI: 201 Created (tarballUrl, integrity)
    else D1 Insert Fails (Conflict / Timeout)
        API->>R2: 8. Rollback: DELETE tarball from R2
        API-->>CLI: 409 Conflict / 500 Internal Error
    end
```

### 9.1 Rules
- **Conditional R2 Put**: Before committing to D1, the tarball is uploaded to R2 with create-only semantics using `onlyIf: { etagDoesNotMatch: "*" }`. If an object with that key already exists, R2 returns a precondition failure and the registry returns `409 CONFLICT`.
- **Atomic D1 Batch**: Metadata is inserted using a single atomic D1 `batch()` transaction containing the `skills` upsert, `skill_versions` record, and all `skill_dependencies` records.
- **Rollback on Error**: If the D1 batch transaction fails, the newly uploaded R2 object is deleted immediately in a rollback block before returning an error.
- **Engine Constraint**: `UNIQUE(skill_name, version)` on table `skill_versions` prevents concurrent race conditions.
- **Latest Version Tracking**: The `skills.latest_version` column is maintained atomically to point to the highest stable, active version (excluding pre-releases and yanked/removed versions).

---

## 10. Downloads Counting & CDN Caching

Download metrics are deduplicated daily per IP hash to provide accurate popularity signals without database lock contention.

### 10.1 Caching Architecture
- Active version download responses set:
  ```http
  Cache-Control: public, max-age=31536000, immutable
  ETag: "<sha256>"
  ```
- Yanked version download responses set:
  ```http
  Cache-Control: public, max-age=300
  ETag: "<sha256>"
  ```
- Removed versions return `410 Gone` with `Cache-Control: no-store`.
- Conditional requests: If the request includes `If-None-Match` matching the version's checksum, the registry immediately returns `304 Not Modified`.
- Tarball bodies are streamed directly from R2 object storage to the client.

### 10.2 Approximate Counting & Deduplication
- **Deduplication Table**: A download is counted at most **once per 24 hours per unique `(skill, version, ip_hash, day)` tuple** in the `download_dedupe` table.
- **IP Hashing**: `ip_hash` is computed as `SHA-256(Client IP + salt)`. Raw IP addresses are never persisted.
- **Filter Incomplete Requests**: `HEAD` requests and HTTP `Range` requests do not increment download counters.

---

## 11. Authentication, Sessions, & CSRF Security

### 11.1 Web Session Cookies
Web sessions created via GitHub OAuth utilize hardened cookie security:
- **Cookie Attributes**:
  - `Name`: `skillapt_session`
  - `Domain`: `.<our-domain>` (e.g. `.skillapt.dev` in production)
  - `HttpOnly`: `true` (inaccessible to clientside scripts)
  - `Secure`: `true` (enforced in production)
  - `SameSite`: `Lax`
  - `Path`: `/`
  - `Max-Age`: 30 days (2,592,000 seconds)
- **Hashed Session Storage**: The `sessions` table stores `SHA-256(session_id)`. Plaintext session tokens are never saved in the database.
- **Session Rotation & Expiration**: Existing sessions are rotated upon authentication, and expired sessions are deleted during authentication lookups.

### 11.2 CSRF Protection on Mutating Requests
Because browsers automatically attach session cookies to requests:
- **Origin Header Verification**: Every state-changing request (`POST`, `PUT`, `DELETE`, `PATCH`) authenticated via session cookie **MUST** validate that the request `Origin` (or `Referer`) exactly matches the configured allowed origins.
- If the `Origin` header does not match an allowed domain, the request is rejected with `403 FORBIDDEN` (`CSRF_VIOLATION`).
- API Bearer tokens (`apt_live_...`) are exempt from CSRF Origin checks because browsers do not attach Bearer headers automatically.

### 11.3 Strict CORS Policy
- Allowed origins are restricted strictly to configured web domains (e.g. `https://skillapt.dev`).
- **Never Wildcard with Credentials**: The header `Access-Control-Allow-Origin: *` is strictly forbidden when credentials are enabled.
- Localhost origins are forbidden when `ENVIRONMENT=production`.
- Responses include `Vary: Origin`.

### 11.4 API Token Security
- Format: `apt_live_<32-random-hex-chars>`.
- Storage: SHA-256 hash digest only. Raw tokens are displayed once upon creation and never retained on the server.
- **Session-Gated Token Minting**: API tokens can only be created or revoked from an authenticated browser session (not via another API token).
- **Caps & Expiration**: Maximum 20 active tokens per user; optional expiration defaulting to 90 days (`expires_at`).

### 11.5 Web Token Dashboard
- `GET /dashboard` renders a minimal, server-rendered HTML interface.
- Governed by a strict Content Security Policy (`default-src 'self'; script-src 'none'; style-src 'unsafe-inline'`).
- Provides CSRF-protected forms to create new API tokens, copy newly generated tokens, view active tokens, revoke tokens, and log out.

---

## 12. Rate Limiting Architecture

Rate limiting is enforced globally using Cloudflare **Durable Objects** (`RateLimiterDO`) running an in-memory sliding window algorithm.

| Scope / Action | Identifier | Rate Limit | Action on Breach |
| :--- | :--- | :--- | :--- |
| **Tarball Downloads** | Client IP (`cf-connecting-ip`) | 120 downloads / minute | `429 Too Many Requests` + `Retry-After` |
| **Package Discovery / Search** | Client IP (`cf-connecting-ip`) | 60 requests / minute | `429 Too Many Requests` |
| **Publishing (`POST /v1/skills`)** | Authenticated User ID | 10 publishes / hour | `429 Too Many Requests` |
| **GitHub OAuth Flow** | Client IP (`cf-connecting-ip`) | 20 logins / 10 minutes | `429 Too Many Requests` |
| **Token Creation (`POST /v1/tokens`)**| Authenticated User ID | 10 creations / day | `429 Too Many Requests` |
| **Abuse Reports (`POST /v1/reports`)** | Client IP (`cf-connecting-ip`) | 5 reports / hour | `429 Too Many Requests` |
| **General API Requests** | API Token / Client IP | 300 requests / minute | `429 Too Many Requests` |

### 12.1 Standard 429 Response
Rate limit breaches return standard HTTP 429 responses with RFC-compliant headers:
- `Retry-After`: Seconds until the limit resets
- `X-RateLimit-Limit`: Maximum requests permitted in the window
- `X-RateLimit-Remaining`: Remaining request quota (0 when rate limited)
- `X-RateLimit-Reset`: Unix timestamp when quota resets
- Response body:
  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many requests. Please wait 60 seconds before retrying.",
      "retryAfter": 60
    }
  }
  ```

---

## 13. Client Requirements (CLI Standards)

The official `skillapt` CLI and third-party tools must conform to these security rules:
1. **Identical Tar Safety**: The CLI must perform the same tar inspection as the registry prior to packaging or after downloading:
   - Reject symlinks, hardlinks, absolute paths, and `..` traversal.
   - Stream decompression with strict 25 MB cutoff.
   - Normalize root folder prefix safely.
2. **Integrity Enforcement**: Verify `SHA-256(downloaded_tarball) === lockfile.integrity` before expanding any archive.
3. **Flat Directory Resolution**: Place installed skills into `.skills/<skill-name>` without nested subdirectories.
4. **Frontmatter Verification**: Verify that installed `SKILL.md` contains valid YAML frontmatter matching the package name.

---

## 14. API Specification Summary

All endpoints are hosted under `/v1`.

### 14.1 Discovery & Search
- `GET /v1/skills?q=&category=&compat=&verified=&sort=&page=&limit=`: Paginated package search.
- `GET /v1/skills/:name`: Package detail, versions map, owner info, and readme.
- `GET /v1/skills/:name/:version`: Specific version metadata including `integrity`, `sha256`, and `status`.
- `GET /v1/skills/:name/-/:version.tgz`: Tarball download stream (`410 Gone` if status is `removed`).

### 14.2 Publishing & Version Management
- `POST /v1/skills`: Publish package (`multipart/form-data` with `file`). Atomic R2 upload with rollback.
- `POST /v1/skills/:name/:version/yank`: Idempotent yank of a published version (sets `yanked = true`).
- `DELETE /v1/skills/:name/:version/yank`: Idempotent un-yank of a published version (sets `yanked = false`).

### 14.3 Admin & Governance
- `POST /v1/admin/skills/:name/:version/takedown`: Mark version as `removed` with report linkage (admin role only).
- `POST /v1/admin/skills/:name/:version/restore`: Restore version from `removed` to `active`/`yanked` (admin role only).
- `GET /v1/admin/reports`: List abuse reports with pagination and status filters (admin role only).
- `POST /v1/admin/reports/:id/resolve`: Mark abuse report as resolved (admin role only).

### 14.4 User & Token Management
- `GET /v1/me`: Profile of current user.
- `GET /v1/tokens`: List user's active API tokens (session auth required).
- `POST /v1/tokens`: Create personal API token (`apt_live_...`, session auth required).
- `DELETE /v1/tokens/:id`: Revoke an API token (session auth required).
- `GET /dashboard`: Server-rendered HTML dashboard with CSP and CSRF protection for managing personal API tokens.

### 14.5 Authentication
- `GET /v1/auth/github`: Initiate OAuth login.
- `GET /v1/auth/github/callback`: OAuth callback, claims user's GitHub scope, and rotates session cookie.
- `POST /v1/auth/logout`: Destroy session and clear cookie.

### 14.6 Platform
- `GET /health` & `GET /v1/health`: System health and version checks.
- `POST /v1/reports`: Submit package abuse report (records `reporter_hash` using salted SHA-256 for privacy).
- `GET /v1/stats`: Homepage metrics.

