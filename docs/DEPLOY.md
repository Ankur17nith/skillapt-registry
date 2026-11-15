# Production Deployment Guide for Skillapt Registry

This document contains step-by-step instructions for the maintainer to deploy `skillapt-registry` to production on Cloudflare Workers.

> [!IMPORTANT]
> In accordance with safety rules, automated AI agents never execute commands with `--remote` or `wrangler deploy`. All commands in this guide must be executed manually by an authorized human operator with Cloudflare administrator credentials.

---

## 1. Prerequisites

Before starting the deployment, verify you have:
1. **Cloudflare Account**: Workers Paid subscription (required for Durable Objects, D1, and R2 bindings).
2. **Domain Configuration**: The `skillapt.dev` apex domain added to your Cloudflare account and active.
3. **Wrangler CLI**: Node.js `>=22.5` and Wrangler v4 installed (`pnpm install` in repo or `npx wrangler`).
4. **Cloudflare Authentication**: Log in to Cloudflare using the CLI:
   ```bash
   npx wrangler login
   ```
   Verify authentication:
   ```bash
   npx wrangler whoami
   ```

---

## 2. Cloudflare Resource Provisioning

### 2.1 Create Production D1 Database
Create the production D1 SQLite database:
```bash
npx wrangler d1 create skillapt-db-prod
```
The command outputs a JSON block with the newly created `database_id` (a UUID, e.g. `12345678-abcd-ef01-2345-6789abcdef01`).

Update `wrangler.jsonc` under `env.production.d1_databases[0]`:
```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "skillapt-db-prod",
    "database_id": "<PASTE-YOUR-PRODUCTION-DATABASE-ID-HERE>"
  }
]
```

### 2.2 Create Production R2 Object Storage Bucket
Create the R2 bucket to store immutable skill package tarballs:
```bash
npx wrangler r2 bucket create skillapt-packages
```

### 2.3 Durable Objects Binding
The Durable Object class `RateLimiterDO` is compiled into the Worker bundle. In `wrangler.jsonc`, `env.production.durable_objects` already configures:
```jsonc
"durable_objects": {
  "bindings": [
    {
      "name": "RATE_LIMITER_DO",
      "class_name": "RateLimiterDO"
    }
  ]
}
```

---

## 3. Apply Production Database Migrations

Apply all numbered SQL migrations (`0001` through `0005`) to the remote production D1 database:
```bash
npx wrangler d1 migrations apply DB --remote --env production
```
Ensure Wrangler reports all migrations applied successfully:
- `0001_initial.sql`
- `0002_scopes_and_latest_version.sql`
- `0003_takedown_and_version_status.sql`
- `0004_auth_tokens_and_sessions.sql`
- `0005_download_dedupe_and_report_privacy.sql`

---

## 4. GitHub OAuth Application Setup

Set up a dedicated GitHub OAuth App for production:
1. Navigate to **GitHub Settings** -> **Developer settings** -> **OAuth Apps** -> **New OAuth App**.
2. Fill in:
   - **Application name**: `Skillapt Registry (Production)`
   - **Homepage URL**: `https://skillapt.dev`
   - **Application description**: `Package registry authentication for skillapt AI agent skills.`
   - **Authorization callback URL**: `https://registry.skillapt.dev/v1/auth/github/callback`
3. Click **Register application**.
4. Note the **Client ID**.
5. Generate a **Client Secret** and copy it securely.

---

## 5. Configure Production Secrets

Inject secrets into Cloudflare Worker production environment using Wrangler.
Never commit secrets or paste them into tracked repository files.

```bash
# 1. GitHub OAuth Client ID
npx wrangler secret put GITHUB_CLIENT_ID --env production

# 2. GitHub OAuth Client Secret
npx wrangler secret put GITHUB_CLIENT_SECRET --env production

# 3. Pepper/Salt for IP hashing in abuse reports and download deduplication
# Generate a cryptographically random 64-character hex string:
# openssl rand -hex 32
npx wrangler secret put HASH_SALT --env production
```

> [!NOTE]
> `HASH_SALT` must be a high-entropy secret (e.g. 32 bytes / 64 hex characters) used for one-way salted hashing of client IP addresses (`SHA-256(IP + salt)`).

---

## 6. Verify Production Build & Dry-Run

Verify the package builds cleanly with no type errors or bundle issues:
```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm audit --prod
npx wrangler deploy --dry-run --env production
```

---

## 7. Deploy Worker to Production

Deploy the Worker to Cloudflare:
```bash
npx wrangler deploy --env production
```

---

## 8. Custom Domain & DNS Attachment

`wrangler.jsonc` has configured:
```jsonc
"routes": [
  {
    "pattern": "registry.skillapt.dev",
    "custom_domain": true
  }
]
```
If not automatically attached by Cloudflare:
1. Open the Cloudflare Dashboard -> **Workers & Pages** -> select `skillapt-registry`.
2. Go to **Settings** -> **Domains & Routes** -> **Add Custom Domain**.
3. Enter `registry.skillapt.dev` and confirm. Cloudflare will automatically provision the SSL/TLS certificate and manage DNS.

---

## 9. Bootstrap the First Administrator

To manage abuse reports and perform package takedowns, bootstrap the primary administrator account:
1. Open a browser and visit `https://registry.skillapt.dev/v1/auth/github`.
2. Log in with your GitHub account. Upon authorization, you will be redirected to `https://registry.skillapt.dev/dashboard`.
   (This creates your user record in production D1).
3. Promote your account to the admin role via Wrangler CLI:
   ```bash
   npx wrangler d1 execute DB --remote --env production --command "UPDATE users SET role = 'admin' WHERE handle = '<your-github-username>';"
   ```
4. Verify your admin status:
   ```bash
   npx wrangler d1 execute DB --remote --env production --command "SELECT id, handle, role FROM users WHERE handle = '<your-github-username>';"
   ```

---

## 10. Run Post-Deployment Verification

On your workstation, create an API token from `/dashboard` or pass an admin token to `scripts/post-deploy-check.sh`:
```bash
REGISTRY_URL="https://registry.skillapt.dev" \
REGISTRY_TOKEN="<your-admin-token>" \
bash scripts/post-deploy-check.sh
```
Verify all checks pass (health check, anonymous search, test package publishing, download integrity check).

---

## 11. Staging Environment Provisioning & Deployment

The staging environment (`env.staging`) provides a safe pre-production environment with completely isolated D1 database, R2 bucket, and Durable Object bindings.

### 11.1 Provision Staging Cloudflare Resources
```bash
# 1. Create Staging D1 Database
npx wrangler d1 create skillapt-db-staging

# 2. Create Staging R2 Bucket
npx wrangler r2 bucket create skillapt-packages-staging
```

Update `wrangler.jsonc` under `env.staging.d1_databases[0]`:
```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "skillapt-db-staging",
    "database_id": "<PASTE-YOUR-STAGING-DATABASE-ID-HERE>",
    "migrations_dir": "migrations"
  }
]
```

### 11.2 Apply Migrations to Staging
```bash
npx wrangler d1 migrations apply DB --remote --env staging
```

### 11.3 Configure Staging Secrets
```bash
# GitHub OAuth app for staging (callback: https://staging-registry.skillapt.dev/v1/auth/github/callback)
npx wrangler secret put GITHUB_CLIENT_ID --env staging
npx wrangler secret put GITHUB_CLIENT_SECRET --env staging

# Salt for IP hashing
npx wrangler secret put HASH_SALT --env staging
```

### 11.4 Deploy to Staging
```bash
npx wrangler deploy --env staging
```

### 11.5 Verify Staging Deployment
```bash
REGISTRY_URL="https://staging-registry.skillapt.dev" \
REGISTRY_TOKEN="<your-staging-token>" \
bash scripts/post-deploy-check.sh
```
