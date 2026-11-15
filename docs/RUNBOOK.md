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
D1 automatically provides point-in-time recovery and snapshot replication. For manual cold backups:

- **Export D1 Database**:
  ```bash
  # Recommended: Run weekly or prior to major upgrades
  npx wrangler d1 export skillapt-db-prod --remote --output="./backup-$(date +%Y%m%d).sql"
  ```
- **Restore D1 Database**:
  ```bash
  # To restore to a fresh database or disaster recovery instance:
  npx wrangler d1 execute skillapt-db-prod --remote --file="./backup-20261115.sql"
  ```

### 2.2 Tarball Storage (R2) Protection
- **Object Immutability**: The registry enforces create-only writes (`onlyIf: { etagDoesNotMatch: "*" }`).
- **Bucket Versioning**: Enable Object Versioning on the R2 bucket `skillapt-packages` in the Cloudflare Dashboard (**R2** -> **Buckets** -> **skillapt-packages** -> **Settings** -> **Object Versioning** -> **Enable**). This protects against accidental administrative deletions.
- **Cross-Region Replication**: Optional: configure replication to a secondary Cloudflare jurisdiction for mission-critical enterprise resilience.

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
