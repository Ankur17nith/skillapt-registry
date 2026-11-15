import { computeSha256 } from "./crypto";
import type { Env } from "../types";

const DEV_FALLBACK_SALT = "skillapt-default-salt";

/**
 * Secret salt for one-way hashing of client IP addresses (download dedupe and
 * abuse reports). Prefers the documented HASH_SALT secret, accepts the legacy
 * REPORT_SALT name, and otherwise derives a private salt from the OAuth client
 * secret so that a hash is never computed with a publicly known constant.
 * The constant is used only when no secret exists at all (local development).
 */
export async function getIpHashSalt(env: Pick<Env, "HASH_SALT" | "REPORT_SALT" | "GITHUB_CLIENT_SECRET">): Promise<string> {
  const explicit = env.HASH_SALT || env.REPORT_SALT;
  if (explicit) return explicit;
  if (env.GITHUB_CLIENT_SECRET) {
    return computeSha256(new TextEncoder().encode(`skillapt:ip-hash-salt:${env.GITHUB_CLIENT_SECRET}`));
  }
  return DEV_FALLBACK_SALT;
}

export async function hashClientIp(
  env: Pick<Env, "HASH_SALT" | "REPORT_SALT" | "GITHUB_CLIENT_SECRET">,
  ip: string
): Promise<string> {
  const salt = await getIpHashSalt(env);
  return computeSha256(new TextEncoder().encode(ip + salt));
}
