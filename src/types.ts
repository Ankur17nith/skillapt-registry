import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  ENVIRONMENT?: string;
  SESSION_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  CORS_ORIGIN?: string;
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
  category: "documents" | "coding" | "research" | "data" | "devtools" | "communication" | "productivity" | "other";
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
}

export interface AppErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
