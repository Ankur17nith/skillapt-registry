# Operations & Incident Response Runbook for Skillapt Registry

This runbook guides registry operators and administrators through emergency response, malware containment, disaster recovery, secret rotation, and system monitoring for `skillapt-registry`.

---

## 1. Malware & Abuse Incident Response (Takedown Procedure)

When an abuse report is received or a package is identified as containing malicious scripts, prompt injections, credentials theft, or copyright violations:

### Step 1: Immediate Package Takedown
Admins can remove the offending version immediately via the admin API.

Using the Admin API:
```bash
# Obtain your admin token from https://registry.skillapt.dev/dashboard
curl -X POST "https://registry.skillapt.dev/v1/admin/skills/@attacker%2Fmalicious-skill/1.0.0/takedown" \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Admin Takedown: Prompt injection and credential harvester in helper script",
    "reportId": "rep_12345"
  }'
```

Emergency Direct D1 Procedure (if API is unreachable):
```bash
npx wrangler d1 execute DB --remote --env production --command \
  "UPDATE skill_versions SET status = 'removed', removal_reason = 'Admin Takedown: Malware report rep_12345', removed_at = datetime('now') WHERE skill_name = '@attacker/malicious-skill' AND version = '1.0.0';"
```

### Step 2: Verify Removal & 410 Gone Status
Confirm that package downloads now return HTTP `410 Gone` with `Cache-Control: no-store`:
```bash
curl -i "https://registry.skillapt.dev/v1/skills/@attacker%2Fmalicious-skill/-/1.0.0.tgz"
# Expected response:
# HTTP/2 410
# cache-control: no-store
# {"error":{"code":"PACKAGE_REMOVED","message":"Version '1.0.0' of skill '@attacker/malicious-skill' has been removed by administrators.","removalReason":"..."}}
```

Verify the CLI refuses to install the package:
```bash
skillapt install @attacker/malicious-skill@1.0.0
# Expected error: HTTP 410 / version removed by administrator
```

### Step 3: Verify Audit Log Record
Every administrative takedown writes an immutable audit record:
```bash
npx wrangler d1 execute DB --remote --env production --command \
  "SELECT id, action, target, actor_id, details, created_at FROM audit_log ORDER BY created_at DESC LIMIT 5;"
```

### Step 4: Community Disclosure & Postmortem
1. If user credentials or systems could be impacted, post a security advisory via GitHub Security Advisories or `SECURITY.md` contact channel.
2. Record an incident postmortem entry in `PLAN.md` Section 13.

### Step 5: Restoration (If Taken Down in Error)
If a takedown was resolved or determined to be a false positive:
```bash
curl -X POST "https://registry.skillapt.dev/v1/admin/skills/@author%2Fskill-name/1.0.0/restore" \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>"
```

---

## 2. Disaster Recovery & Backups

### 2.1 Database (D1) Backups & Restores
D1 automatically provides snapshot replication and point-in-time recovery on Workers Paid plans. For manual cold backups, disaster recovery, pre-migration snapshots, or compliance archives:

#### Manual Export Procedure
Run `wrangler d1 export` to generate a self-contained SQL dump including table schemas and all rows:
```bash
# Recommended schedule: Daily or immediately prior to applying any D1 schema migration
BACKUP_DIR="./backups"
mkdir -p "${BACKUP_DIR}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Export production D1 database
BACKUP_FILE="${BACKUP_DIR}/skillapt-db-prod-${TIMESTAMP}.sql"
npx wrangler d1 export skillapt-db-prod --remote --output="${BACKUP_FILE}"

# (Optional) Export staging D1 database
# npx wrangler d1 export skillapt-db-staging --remote --output="${BACKUP_DIR}/skillapt-db-staging-${TIMESTAMP}.sql"

# Verify export integrity
head -n 25 "${BACKUP_FILE}"
ls -lh "${BACKUP_FILE}"
```

#### Database Restore Procedure
To restore a snapshot to a target D1 database (disaster recovery or sandbox testing):
```bash
# 1. Execute SQL dump against target D1 database
npx wrangler d1 execute skillapt-db-prod --remote --file="${BACKUP_FILE}"

# 2. Verify table records and latest versions
npx wrangler d1 execute skillapt-db-prod --remote --command \
  "SELECT count(*) AS total_skills FROM skills; SELECT count(*) AS total_versions FROM skill_versions;"
```

### 2.2 Tarball Storage (R2) Protection & Periodic Backup
> [!NOTE]
> Cloudflare R2 does not natively support S3-style object versioning. The registry protects tarball assets through application-level immutability and periodic backup strategies.

- **Object Immutability**: The registry strictly enforces create-only writes (`onlyIf: { etagDoesNotMatch: "*" }`), mathematically preventing overwriting any existing version of a package.
- **Accidental Deletion & Disaster Protection**:
  1. **Soft Takedowns**: Administrative removals in `skillapt-registry` are soft-deletions recorded in D1 (`status = 'removed'`, returning `410 Gone`). The Worker API never issues `DELETE` requests to R2 for published packages.
  2. **Access Control / Least Privilege**: Configure production Cloudflare API tokens with `Object Read & Write` permissions only; do not grant `Bucket Delete` or `Object Delete` permissions to Worker execution roles.
  3. **Periodic Backup Copy**: To maintain an independent off-site or cross-bucket cold backup, run a daily sync to a secondary backup bucket or external S3-compatible cold storage:
     ```bash
     # Example: Periodic sync using rclone or AWS CLI with R2 S3 endpoint
     rclone sync cloudflare:skillapt-packages cloudflare:skillapt-packages-backup
     ```
     Alternatively, use Cloudflare Super Slurper or an automated scheduled Cloudflare Worker to replicate newly created tarballs into `skillapt-packages-backup`.

### 2.3 Worker Deployment Rollback
If a newly deployed Worker script introduces a regression or instability:
```bash
# View deployment history
npx wrangler deployments list --env production

# Instantly rollback to previous active deployment
npx wrangler rollback --env production
```

---

## 3. Secrets & Key Rotation

### 3.1 GitHub OAuth Client Secret Rotation
To rotate GitHub OAuth credentials with zero user downtime:
1. Go to **GitHub Settings** -> **Developer settings** -> **OAuth Apps** -> Select app.
2. Under **Client secrets**, click **Generate a new client secret**. Both secrets will remain valid during transition.
3. Update production secret:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET --env production
   ```
4. Test login at `https://registry.skillapt.dev/v1/auth/github`.
5. Once verified, return to GitHub OAuth settings and delete the old client secret.

### 3.2 HASH_SALT Rotation
`HASH_SALT` is used to salt client IP addresses before hashing for download deduplication and abuse report reporter tracking.
- **Rotation Impact**:
  - Existing lifetime download metrics (`download_count` in `skill_versions`) are permanently stored as integers and **unaffected**.
  - Daily download deduplication (`download_dedupe`) resets for the current day.
- **Rotation Command**:
  ```bash
  NEW_SALT=$(openssl rand -hex 32)
  echo "${NEW_SALT}" | npx wrangler secret put HASH_SALT --env production
  ```

### 3.3 Emergency API Token Revocation
If a publisher's API token is leaked:
- **By Publisher**: Go to `https://registry.skillapt.dev/dashboard` and click **Revoke** next to the compromised token.
- **By Admin (Emergency SQL)**:
  ```bash
  npx wrangler d1 execute DB --remote --env production --command \
    "DELETE FROM api_tokens WHERE user_id = (SELECT id FROM users WHERE handle = '<user-handle>');"
  ```

---

## 4. Monitoring, Health Checks & Observability

### 4.1 Live Log Tailing
Tail real-time requests and errors:
```bash
npx wrangler tail --env production
```
Format structured output with `jq`:
```bash
npx wrangler tail --env production --format json | jq -r 'select(.outcome != "ok") | [.eventTimestamp, .outcome, .scriptName, .exceptions] | @tsv'
```

### 4.2 Key Health Metrics & Alerting Thresholds
Monitor the following metrics in Cloudflare Workers Analytics:
1. **HTTP 5xx Rate**: Alert if 5xx error responses exceed **1%** over any 5-minute sliding window.
2. **Publish Failures**: Alert if `POST /v1/skills` returns unexpected 500 errors (indicates D1 or R2 outage).
3. **Durable Object CPU Duration**: Normal latency is < 5ms. Alert if DO duration exceeds **50ms** sustained.
4. **Rate Limit Breach Spikes**: Sudden spikes in 429 errors indicate a potential brute-force attack or distributed scraping attempt.

---

## 5. Read-Only / Maintenance Mode Procedure

If urgent database maintenance or schema refactoring is required and writes must be rejected while keeping searches and downloads online:

### Option A: Read-Only Maintenance via Worker Configuration
In `wrangler.jsonc`, set under `env.production.vars`:
```jsonc
"vars": {
  "MAINTENANCE_MODE": "true"
}
```
Deploy the update:
```bash
npx wrangler deploy --env production
```
In this mode, all mutating routes (`POST /v1/skills`, `POST /v1/tokens`, `POST /v1/skills/:name/:version/yank`) return HTTP `503 Service Unavailable` with message: `"Registry is in scheduled read-only maintenance mode."`

### Option B: Cloudflare WAF Managed Rule (Zero Code Deploy)
1. Open Cloudflare Dashboard -> **Security** -> **WAF** -> **Custom Rules**.
2. Add Rule:
   - Field: `http.request.method` in `{"POST", "PUT", "DELETE", "PATCH"}`
   - URI Path: not in `{"/v1/auth/github", "/v1/auth/github/callback"}`
   - Action: **Block** (or Return Custom 503 response).
3. Disable the rule once maintenance is complete.
