import type { D1Database, R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { RateLimiter } from "./rate-limiter/do";

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  ENVIRONMENT?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  CORS_ORIGIN?: string;
  PUBLIC_ORIGIN?: string;
  /** "true" rejects all mutating requests with 503 (read-only maintenance). */
  MAINTENANCE_MODE?: string;
  RATE_LIMITER_DO?: DurableObjectNamespace;
  RATE_LIMITER?: RateLimiter;
  /** Secret salt for hashing client IPs (preferred name). */
  HASH_SALT?: string;
  /** Legacy name for HASH_SALT. */
  REPORT_SALT?: string;
}

export type PermissionFilesystem = "none" | "read" | "write" | "read-write";

export interface PackagePermissions {
  network: boolean;
  shell: boolean;
  filesystem: PermissionFilesystem;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  license: string;
  repository?: string;
  keywords?: string[];
  category: string;
  compatibility: string[];
  dependencies?: Record<string, string>;
  permissions: PackagePermissions;
}

export interface UserSession {
  userId: string;
  githubId: number;
  handle: string;
  name: string;
  email: string | null;
  avatarUrl: string;
  role?: string;
}

export interface AppErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
