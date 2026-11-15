import type { Env } from "../types";

/**
 * Only an explicit `development` or `test` ENVIRONMENT relaxes protections.
 * A missing or unknown value (for example a deployment that forgot to set it)
 * is treated as production so that misconfiguration fails safe.
 */
export function isProductionLike(env?: Pick<Env, "ENVIRONMENT">): boolean {
  const name = env?.ENVIRONMENT;
  return name !== "development" && name !== "test";
}

// Convenience defaults for local development and the test suite only.
const NON_PRODUCTION_DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://skillapt.dev"
];

function isLocalOrigin(origin: string): boolean {
  return origin.includes("localhost") || origin.includes("127.0.0.1");
}

/**
 * Exact-match origin allowlist used for CORS and CSRF Origin/Referer checks.
 *
 * Production: only origins listed in CORS_ORIGIN (minus localhost) plus
 * PUBLIC_ORIGIN. With nothing configured, no browser origin is allowed.
 */
export function getAllowedOrigins(env?: Pick<Env, "ENVIRONMENT" | "CORS_ORIGIN" | "PUBLIC_ORIGIN">): string[] {
  const configured = (env?.CORS_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (!isProductionLike(env)) {
    return configured.length > 0 ? configured : NON_PRODUCTION_DEFAULT_ORIGINS;
  }

  const origins = configured.filter((o) => o === "*" || !isLocalOrigin(o));
  const publicOrigin = env?.PUBLIC_ORIGIN?.trim();
  if (publicOrigin && !origins.includes(publicOrigin)) {
    origins.push(publicOrigin);
  }
  return origins;
}

/** True when CORS_ORIGIN contains the forbidden wildcard. */
export function hasWildcardOrigin(env?: Pick<Env, "CORS_ORIGIN">): boolean {
  return (env?.CORS_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .includes("*");
}
