/**
 * Core product configuration.
 * The product name MUST live in this single constant.
 */
export const PRODUCT_NAME = "skillapt" as const;

export const REGISTRY_VERSION = "1.0.0" as const;

export const LIMITS = {
  MAX_TARBALL_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
  MAX_UNCOMPRESSED_SIZE_BYTES: 25 * 1024 * 1024, // 25 MB
  MAX_SKILL_MD_SIZE_BYTES: 256 * 1024, // 256 KB
  MAX_FILE_COUNT: 500,
  MAX_PATH_LENGTH: 255,
  MAX_NAME_LENGTH: 50,
  MIN_NAME_LENGTH: 3,
  MAX_VERSION_LENGTH: 64,
  MAX_DESCRIPTION_LENGTH: 300,
  MIN_DESCRIPTION_LENGTH: 10,
  MAX_KEYWORDS: 10,
  MAX_DEPENDENCIES: 50,
  MAX_DEPENDENCY_DEPTH: 10
} as const;

export const RESERVED_NAMES = new Set([
  "skillapt",
  "admin",
  "api",
  "www",
  "official",
  "registry",
  "support",
  "security",
  "root",
  "claude",
  "openai",
  "anthropic",
  "cursor",
  "codex",
  "antigravity",
  "gemini",
  "chatgpt",
  "null",
  "undefined",
  "core",
  "internal",
  "system",
  "auth",
  "account",
  "dashboard"
]);

export const ALLOWED_FILE_EXTENSIONS = new Set([
  // Documentation & Prompts
  ".md",
  ".txt",
  ".prompt",
  ".rst",
  // Data & Configuration
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".xml",
  ".xsd",
  // Web
  ".html",
  ".css",
  ".svg",
  // Templates
  ".jinja",
  ".jinja2",
  ".mustache",
  ".hbs",
  ".template",
  // Common Scripts
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".lua",
  ".rb"
]);

export const ALLOWED_SPECIAL_FILES = new Set([
  ".gitignore",
  ".editorconfig"
]);

export const ALLOWED_EXTENSIONLESS_FILES = new Set([
  "license",
  "notice",
  "readme",
  "changelog",
  "makefile"
]);
