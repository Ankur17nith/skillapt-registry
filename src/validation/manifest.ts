import { z } from "zod";
import semver from "semver";
import { LIMITS, RESERVED_NAMES } from "../config";

// Regex for valid package name:
// Optional @scope/ where scope is 2-30 chars [a-z0-9-]
// Name is 3-50 chars [a-z0-9-], cannot start or end with hyphen
export const PACKAGE_NAME_REGEX = /^(@[a-z0-9-]{2,30}\/)?[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export const CategoryEnum = z.enum([
  "documents",
  "coding",
  "research",
  "data",
  "devtools",
  "communication",
  "productivity",
  "other"
]);

export const ALLOWED_CATEGORIES: Set<string> = new Set<string>(CategoryEnum.options);

export const CompatibilityEnum = z.enum([
  "claude",
  "cursor",
  "codex",
  "antigravity",
  "openai",
  "custom"
]);

export const PermissionsSchema = z.object({
  network: z.boolean({ required_error: "permissions.network is required" }),
  shell: z.boolean({ required_error: "permissions.shell is required" }),
  filesystem: z.enum(["none", "read", "write", "read-write"], {
    required_error: "permissions.filesystem must be one of: none, read, write, read-write"
  })
});

export const LICENSE_REGEX = /^[a-zA-Z0-9\s.\-()+/]{1,50}$/;

export const SkillManifestSchema = z.object({
  name: z
    .string()
    .min(LIMITS.MIN_NAME_LENGTH, `Name must be at least ${LIMITS.MIN_NAME_LENGTH} characters`)
    .max(LIMITS.MAX_NAME_LENGTH, `Name cannot exceed ${LIMITS.MAX_NAME_LENGTH} characters`)
    .regex(
      PACKAGE_NAME_REGEX,
      "Name must be lowercase letters, digits, and hyphens (3-50 chars), with optional @scope/"
    )
    .refine((name) => {
      if (name.startsWith("@")) {
        const parts = name.slice(1).split("/");
        if (parts.length !== 2) return false;
        const [, pkg] = parts;
        return !RESERVED_NAMES.has(pkg);
      }
      return !RESERVED_NAMES.has(name);
    }, {
      message: "Package name is a reserved name"
    }),
  version: z
    .string()
    .max(LIMITS.MAX_VERSION_LENGTH, `Version cannot exceed ${LIMITS.MAX_VERSION_LENGTH} characters`)
    .refine((v) => semver.valid(v) === v && !v.includes("+"), {
      message: "Version must be a canonical Semantic Version without build metadata (e.g. 1.0.0)"
    }),
  description: z
    .string()
    .min(LIMITS.MIN_DESCRIPTION_LENGTH, `Description must be at least ${LIMITS.MIN_DESCRIPTION_LENGTH} characters`)
    .max(LIMITS.MAX_DESCRIPTION_LENGTH, `Description cannot exceed ${LIMITS.MAX_DESCRIPTION_LENGTH} characters`),
  license: z
    .string()
    .min(1, "License is required")
    .max(50, "License cannot exceed 50 characters")
    .regex(LICENSE_REGEX, "License contains invalid characters or exceeds 50 characters"),
  repository: z
    .string()
    .regex(/^https:\/\/[^\s]+$/, "Repository must be an HTTPS URL")
    .optional(),
  keywords: z
    .array(
      z.string().regex(/^[a-z0-9-]+$/, "Keyword must be lowercase alphanumeric and hyphens").max(30)
    )
    .max(LIMITS.MAX_KEYWORDS, `Cannot specify more than ${LIMITS.MAX_KEYWORDS} keywords`)
    .optional()
    .default([]),
  category: CategoryEnum,
  compatibility: z
    .array(CompatibilityEnum)
    .min(1, "At least one compatibility target must be specified")
    .max(20),
  dependencies: z
    .record(
      z.string().regex(PACKAGE_NAME_REGEX, "Dependency name must be a valid package name"),
      z.string().refine((range) => semver.validRange(range) !== null, {
        message: "Dependency version must be a valid SemVer range"
      })
    )
    .refine((deps) => Object.keys(deps).length <= LIMITS.MAX_DEPENDENCIES, {
      message: `Cannot specify more than ${LIMITS.MAX_DEPENDENCIES} dependencies`
    })
    .optional()
    .default({}),
  permissions: PermissionsSchema
}).refine((manifest) => {
  if (manifest.dependencies && manifest.dependencies[manifest.name]) {
    return false;
  }
  return true;
}, {
  message: "Package cannot declare a dependency on itself",
  path: ["dependencies"]
});

export type ValidatedSkillManifest = z.infer<typeof SkillManifestSchema>;

export function validateManifest(rawJson: unknown): { success: true; data: ValidatedSkillManifest } | { success: false; errors: string[] } {
  const result = SkillManifestSchema.safeParse(rawJson);
  if (!result.success) {
    const errorMessages = result.error.errors.map((err) => `${err.path.join(".")}: ${err.message}`);
    return { success: false, errors: errorMessages };
  }
  return { success: true, data: result.data };
}
