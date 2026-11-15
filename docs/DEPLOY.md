# Deploying skillapt-registry on Cloudflare's free tier

This guide takes you from a fresh clone to a running registry on a free
`*.workers.dev` address. **No domain name and no paid plan are required.**

> [!IMPORTANT]
> Every command below is run **by you**, a human operator, with your own Cloudflare
> account. Automated agents in this repository never run `wrangler login`,
> `wrangler deploy` or any `--remote` command.

---

## 0. What you get, and the free-tier limits

| Component | Cloudflare service | Free-tier allowance (check Cloudflare's pricing page, limits change) |
| :--- | :--- | :--- |
| API | Workers | 100,000 requests/day, **10 ms CPU per request** |
| Metadata | D1 (SQLite) | 5 GB storage, 5 million rows read/day, 100,000 rows written/day |
| Package tarballs | R2 | 10 GB storage, 1M writes and 10M reads per month, no egress fees |
| Rate limiting | Durable Objects (SQLite-backed) | 100,000 requests/day |
| Cleanup job | Cron Triggers | included (this project uses one) |

What this means in practice:

- **R2 needs a payment method on file** even though the free allowance costs nothing.
  If you will not add one, you cannot use R2; there is no free alternative wired into this project.
- The **10 ms CPU** limit applies to the free Workers plan. Publishing validates a
  gzip+tar archive and hashes it, which can exceed 10 ms for large packages
  (Cloudflare returns error 1102). Small skills (a few hundred KB) are fine;
  large publishes may need the Workers Paid plan.
- The **Durable Object** rate limiter is called once per API request. When its
  100,000 requests/day quota is used up, the registry **fails open** (requests are
  served without rate limiting) instead of returning errors.
- You get a URL like `https://skillapt-registry.<your-subdomain>.workers.dev`. Browsers
  and the CLI use it over HTTPS; there is nothing to configure for TLS.

---

## 1. Prerequisites

1. A free Cloudflare account (https://dash.cloudflare.com/sign-up).
2. A GitHub account (for the OAuth app that signs publishers in).
3. Node.js **>= 22.5** and `pnpm`.
4. This repository cloned, with dependencies installed:

   ```bash
   pnpm install --frozen-lockfile
   ```

5. Log in to Cloudflare (opens a browser):

   ```bash
   npx wrangler login
   npx wrangler whoami
   ```

---

## 2. Create the Cloudflare resources

### 2.1 D1 database

```bash
npx wrangler d1 create skillapt-db
```

Copy the `database_id` it prints and paste it into `wrangler.jsonc`, replacing the
`REPLACE_WITH_YOUR_D1_DATABASE_ID` placeholder.

### 2.2 R2 bucket

```bash
npx wrangler r2 bucket create skillapt-packages
```

(R2 must be enabled first in the dashboard under **R2 Object Storage**, which is
where Cloudflare asks for a payment method.)

### 2.3 Durable Object

Nothing to create. `RateLimiterDO` ships inside the Worker and `wrangler.jsonc`
declares it with `new_sqlite_classes`, the only Durable Object kind the free plan allows.

---

## 3. Apply the database migrations

```bash
npx wrangler d1 migrations apply DB --remote
```

All five migrations (`0001` to `0005`) should be reported as applied.

---

## 4. Create a GitHub OAuth app

You need your Worker URL for this, and Cloudflare only shows it after the first
deploy. The easiest order is: deploy once (step 6), note the URL, then come back.
Your URL is `https://skillapt-registry.<your-subdomain>.workers.dev`; the
`<your-subdomain>` is shown by `wrangler deploy` and under **Workers & Pages**.

1. GitHub: **Settings > Developer settings > OAuth Apps > New OAuth App**.
2. Fill in:
   - **Application name**: `Skillapt Registry`
   - **Homepage URL**: your Worker URL (or your Pages site URL)
   - **Authorization callback URL**: `<your Worker URL>/v1/auth/github/callback`
3. Register it, copy the **Client ID**, and generate a **Client Secret**.

---

## 5. Configure variables and secrets

### 5.1 Plain variables (in `wrangler.jsonc`, section `vars`)

| Variable | Value |
| :--- | :--- |
| `ENVIRONMENT` | Keep `production`. Any value other than `development`/`test` is treated as production. |
| `PUBLIC_ORIGIN` | Your Worker URL, e.g. `https://skillapt-registry.<your-subdomain>.workers.dev` |
| `CORS_ORIGIN` | Exact, comma-separated origins allowed to call the API from a browser, e.g. your Cloudflare Pages site `https://skillapt-web.pages.dev`. `*` and localhost are rejected in production. Leave empty to allow none. |

### 5.2 Secrets (never committed)

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
# A long random value used to salt hashed client IPs:
openssl rand -hex 32            # copy the output, then:
npx wrangler secret put HASH_SALT
```

`HASH_SALT` protects the stored IP hashes (download de-duplication and abuse
reports). If you skip it the Worker derives a salt from `GITHUB_CLIENT_SECRET`,
so set it anyway.

---

## 6. Verify, then deploy

```bash
pnpm typecheck
pnpm test
pnpm audit --prod
npx wrangler deploy --dry-run     # builds the bundle, uploads nothing
npx wrangler deploy               # publishes to <name>.workers.dev
```

`wrangler deploy` prints your live URL. Put it into `PUBLIC_ORIGIN` (step 5.1),
use it for the OAuth callback (step 4), and deploy once more if you changed vars.

> The repository also contains a manual GitHub Actions workflow
> (`.github/workflows/deploy.yml`). It needs the secrets `CLOUDFLARE_API_TOKEN`
> and `CLOUDFLARE_ACCOUNT_ID`; without them it only reports that deployment was skipped.

---

## 7. Create the first administrator

1. Visit `<your Worker URL>/dashboard` and sign in with GitHub. This creates your user row.
2. Promote yourself (admins can take packages down):

   ```bash
   npx wrangler d1 execute DB --remote --command \
     "UPDATE users SET role = 'admin' WHERE handle = '<your-github-handle>';"
   npx wrangler d1 execute DB --remote --command \
     "SELECT id, handle, role FROM users WHERE handle = '<your-github-handle>';"
   ```

3. In the dashboard, generate a personal access token (`apt_live_...`). It is shown **once**.

---

## 8. Post-deployment verification

```bash
REGISTRY_URL="https://skillapt-registry.<your-subdomain>.workers.dev" \
REGISTRY_TOKEN="apt_live_..." \
bash scripts/post-deploy-check.sh
```

The script checks `/v1/health`, anonymous search, an authenticated publish of a
tiny test package, and the SHA-256 of the downloaded tarball. Without
`REGISTRY_TOKEN` it only runs the read-only checks.

Point the CLI at your registry:

```bash
export SKILLAPT_REGISTRY="https://skillapt-registry.<your-subdomain>.workers.dev"
skillapt search pdf
```

---

## 9. Hosting the web frontend (optional)

The `skillapt-web` site deploys to Cloudflare Pages for free (see its README).
After you know its URL (for example `https://skillapt-web.pages.dev`), add that
exact origin to `CORS_ORIGIN` here and run `npx wrangler deploy` again.

---

## 10. Adding a custom domain later (optional)

If you later buy a domain and add it to Cloudflare, uncomment the `routes`
example at the bottom of `wrangler.jsonc`, set `PUBLIC_ORIGIN` / `CORS_ORIGIN`
to the new origins, update the GitHub OAuth callback URL, and redeploy.

---

## 11. Troubleshooting

| Symptom | Likely cause |
| :--- | :--- |
| `wrangler deploy` complains about the D1 id | `REPLACE_WITH_YOUR_D1_DATABASE_ID` is still in `wrangler.jsonc`. |
| Login redirects to GitHub with "redirect_uri mismatch" | The OAuth callback URL does not equal `<Worker URL>/v1/auth/github/callback`. |
| Browser calls fail with a CORS error | The page's exact origin is missing from `CORS_ORIGIN`. |
| Publish fails with error 1102 | Free-plan CPU limit exceeded; publish a smaller package. |
| `/dashboard` sign-in loops | `ENVIRONMENT` is `development` on a deployed Worker, or cookies are blocked. Cookies are `Secure`, so use HTTPS. |
