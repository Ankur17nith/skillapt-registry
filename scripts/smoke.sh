#!/usr/bin/env bash
set -euo pipefail

PORT=${PORT:-8789}
LOG_FILE=$(mktemp)

echo "Starting wrangler dev on port ${PORT}..."
pnpm wrangler dev --local --port "${PORT}" --ip 127.0.0.1 > "${LOG_FILE}" 2>&1 &
DEV_PID=$!

cleanup() {
  echo "Cleaning up wrangler process (PID ${DEV_PID})..."
  kill "${DEV_PID}" 2>/dev/null || true
  wait "${DEV_PID}" 2>/dev/null || true
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT INT TERM

echo "Waiting for workerd runtime to start..."
MAX_ATTEMPTS=60
ATTEMPT=0
SUCCESS=0

while [ ${ATTEMPT} -lt ${MAX_ATTEMPTS} ]; do
  if ! kill -0 "${DEV_PID}" 2>/dev/null; then
    echo "ERROR: wrangler dev process died prematurely."
    cat "${LOG_FILE}"
    exit 1
  fi

  HTTP_CODE=$(curl -s -o /tmp/smoke_response.json -w "%{http_code}" "http://127.0.0.1:${PORT}/v1/health" || true)
  if [ "${HTTP_CODE}" = "200" ]; then
    if grep -q '"status":"ok"' /tmp/smoke_response.json; then
      echo "Health check succeeded: 200 OK with status:ok"
      cat /tmp/smoke_response.json
      echo ""
      SUCCESS=1
      break
    fi
  fi

  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.5
done

rm -f /tmp/smoke_response.json

if [ ${SUCCESS} -ne 1 ]; then
  echo "ERROR: workerd smoke test timed out waiting for /v1/health."
  echo "Wrangler log output:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "Workerd smoke test passed successfully!"
exit 0
