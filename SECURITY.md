# Security Policy

skillapt-registry distributes software that AI agents may run, so we take security reports seriously.

## Supported versions

Only the latest release line receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| < 1.2.0 | No        |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:

1. Go to the repository's **Security** tab and choose
   [**Report a vulnerability**](https://github.com/Ankur17nith/skillapt-registry/security/advisories/new).
2. Include, as far as you can:
   - what the vulnerability is and the impact you believe it has,
   - step-by-step reproduction (a proof of concept or a failing test is ideal),
   - the affected endpoint, component or version,
   - any suggested fix.

Do not include real user data, tokens or secrets in your report.

## What to expect

This is a volunteer-maintained project, so these are targets rather than guarantees:

| Step | Target |
| :--- | :--- |
| Acknowledge your report | within 3 days |
| Initial assessment and severity | within 7 days |
| Fix for critical/high issues | within 30 days |
| Fix for medium/low issues | next regular release |

We will keep you updated, credit you in the advisory and changelog if you wish, and
coordinate disclosure with you. Please give us a reasonable chance to ship a fix before
you disclose publicly.

## Scope

In scope: the Worker code in this repository (authentication, authorization, package
validation, storage, rate limiting, the dashboard, scripts and CI workflows).

Examples we care about: authentication or authorization bypass, ways to publish into
someone else's name or scope, archive validation bypasses (path traversal, smuggled
entries, executables), injection (SQL, HTML, header), leaking tokens or secrets,
CSRF or CORS bypass, denial of service from a single small request.

Out of scope: vulnerabilities in third-party services (Cloudflare, GitHub), social
engineering, spam or malicious *skills* published by users (report those to the registry's
abuse process via `POST /v1/reports` or the dashboard), volumetric denial of service,
and findings that need a compromised maintainer account.

## Safe harbor

If you act in good faith, avoid privacy violations and service disruption, and only test
against your own deployment, we will not pursue legal action over your research.

## Operator hardening

If you run your own instance, see [`docs/DEPLOY.md`](docs/DEPLOY.md) and
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) (secret rotation, token revocation, takedowns).
Always set `ENVIRONMENT=production`, `HASH_SALT`, and an exact `CORS_ORIGIN` allowlist.
