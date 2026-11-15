#!/usr/bin/env bash
set -euo pipefail

if [ -z "${REGISTRY_URL:-}" ]; then
  echo "Usage: REGISTRY_URL=https://skillapt-registry.<subdomain>.workers.dev [REGISTRY_TOKEN=...] bash scripts/post-deploy-check.sh" >&2
  exit 2
fi
REGISTRY_URL="${REGISTRY_URL%/}" # Strip trailing slash

echo "====================================================="
echo "   skillapt Registry Post-Deployment Verification    "
echo "====================================================="
echo "Target Registry URL: ${REGISTRY_URL}"
echo ""

TMP_DIR=$(mktemp -d /tmp/skillapt-post-deploy-XXXXXX)
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

# 1. Health check
echo "[1/4] Checking /v1/health endpoint..."
HEALTH_FILE="${TMP_DIR}/health.json"
HTTP_CODE=$(curl -s -w "%{http_code}" -o "${HEALTH_FILE}" "${REGISTRY_URL}/v1/health" || true)

if [ "${HTTP_CODE}" != "200" ]; then
  echo "❌ FAILED: Health endpoint returned HTTP ${HTTP_CODE} instead of 200."
  cat "${HEALTH_FILE}" 2>/dev/null || true
  exit 1
fi

if ! grep -q '"status":"ok"' "${HEALTH_FILE}"; then
  echo "❌ FAILED: Health response missing '\"status\":\"ok\"'."
  cat "${HEALTH_FILE}"
  exit 1
fi

if ! grep -q '"product":"skillapt"' "${HEALTH_FILE}"; then
  echo "❌ FAILED: Health response missing '\"product\":\"skillapt\"'."
  cat "${HEALTH_FILE}"
  exit 1
fi

if ! grep -q '"version":"1.2.0"' "${HEALTH_FILE}"; then
  echo "❌ FAILED: Health response missing '\"version\":\"1.2.0\"'."
  cat "${HEALTH_FILE}"
  exit 1
fi

echo "   ✔ Health check passed (HTTP 200, product=skillapt, version=1.2.0)."

# 2. Anonymous Search check
echo "[2/4] Checking anonymous /v1/skills search endpoint..."
SEARCH_FILE="${TMP_DIR}/search.json"
HTTP_CODE=$(curl -s -w "%{http_code}" -o "${SEARCH_FILE}" "${REGISTRY_URL}/v1/skills?limit=10" || true)

if [ "${HTTP_CODE}" != "200" ]; then
  echo "❌ FAILED: Search endpoint returned HTTP ${HTTP_CODE} instead of 200."
  cat "${SEARCH_FILE}" 2>/dev/null || true
  exit 1
fi

if ! grep -q '"skills":' "${SEARCH_FILE}"; then
  echo "❌ FAILED: Search response missing 'skills' key."
  cat "${SEARCH_FILE}"
  exit 1
fi

echo "   ✔ Search check passed (HTTP 200, valid JSON response with 'skills' array)."

# 3. Authenticated Publish & Download check (if REGISTRY_TOKEN provided)
if [ -z "${REGISTRY_TOKEN:-}" ]; then
  echo "[3/4] Skipping publish verification (REGISTRY_TOKEN environment variable not set)."
  echo "[4/4] Verification completed successfully for public read endpoints."
else
  echo "[3/4] Checking authenticated package publish with REGISTRY_TOKEN..."
  
  PKG_DIR="${TMP_DIR}/test-pkg"
  mkdir -p "${PKG_DIR}"

  # Create valid skill.json
  cat > "${PKG_DIR}/skill.json" << 'EOF'
{
  "name": "post-deploy-check-pkg",
  "version": "1.0.0",
  "description": "Post deployment verification test skill for registry health",
  "license": "MIT",
  "category": "devtools",
  "compatibility": ["claude", "antigravity"],
  "permissions": {
    "network": false,
    "shell": false,
    "filesystem": "none"
  }
}
EOF

  # Create valid SKILL.md
  cat > "${PKG_DIR}/SKILL.md" << 'EOF'
---
name: post-deploy-check-pkg
description: Post deployment verification test skill for registry health
---
# Post Deploy Check Skill

This is an automated test package used to verify publishing and downloading on the skillapt registry.
EOF

  TARBALL="${TMP_DIR}/test-pkg.tgz"
  # Package with consistent prefix
  tar -czf "${TARBALL}" -C "${PKG_DIR}" skill.json SKILL.md

  # Compute local sha256
  if command -v sha256sum >/dev/null 2>&1; then
    LOCAL_SHA=$(sha256sum "${TARBALL}" | awk '{print $1}')
  else
    LOCAL_SHA=$(shasum -a 256 "${TARBALL}" | awk '{print $1}')
  fi

  PUBLISH_RESP="${TMP_DIR}/publish.json"
  HTTP_CODE=$(curl -s -w "%{http_code}" -o "${PUBLISH_RESP}" \
    -X POST "${REGISTRY_URL}/v1/skills" \
    -H "Authorization: Bearer ${REGISTRY_TOKEN}" \
    -F "file=@${TARBALL}" || true)

  if [ "${HTTP_CODE}" = "201" ]; then
    echo "   ✔ Publish succeeded with HTTP 201 Created."
  elif [ "${HTTP_CODE}" = "409" ]; then
    echo "   ✔ Package version already published (HTTP 409 Conflict - expected idempotent check)."
  else
    echo "❌ FAILED: Publish returned unexpected HTTP status ${HTTP_CODE}."
    cat "${PUBLISH_RESP}" 2>/dev/null || true
    exit 1
  fi

  # 4. Download and verify hash
  echo "[4/4] Downloading tarball and verifying cryptographic hash..."
  DOWNLOADED_TARBALL="${TMP_DIR}/downloaded.tgz"
  HTTP_CODE=$(curl -s -w "%{http_code}" -o "${DOWNLOADED_TARBALL}" \
    "${REGISTRY_URL}/v1/skills/post-deploy-check-pkg/-/1.0.0.tgz" || true)

  if [ "${HTTP_CODE}" != "200" ]; then
    echo "❌ FAILED: Tarball download returned HTTP ${HTTP_CODE} instead of 200."
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    DOWNLOAD_SHA=$(sha256sum "${DOWNLOADED_TARBALL}" | awk '{print $1}')
  else
    DOWNLOAD_SHA=$(shasum -a 256 "${DOWNLOADED_TARBALL}" | awk '{print $1}')
  fi

  echo "   Downloaded SHA-256: ${DOWNLOAD_SHA}"

  # Get version metadata to check integrity field
  META_FILE="${TMP_DIR}/meta.json"
  curl -s -o "${META_FILE}" "${REGISTRY_URL}/v1/skills/post-deploy-check-pkg/1.0.0"
  if ! grep -q "${DOWNLOAD_SHA}" "${META_FILE}"; then
    echo "❌ FAILED: Metadata integrity checksum does not match downloaded file."
    cat "${META_FILE}"
    exit 1
  fi

  echo "   ✔ Tarball downloaded and integrity checksum verified successfully."
fi

echo ""
echo "====================================================="
echo "   ALL POST-DEPLOYMENT VERIFICATION CHECKS PASSED    "
echo "====================================================="
