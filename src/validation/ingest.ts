import { z } from "zod";
import { LIMITS } from "../config";
import { CATEGORY_IDS } from "../taxonomy";
import { CompatibilityEnum, LICENSE_REGEX, PACKAGE_NAME_REGEX } from "./manifest";

/** Maximum skills accepted in one ingest call (keeps a single D1 batch small). */
export const MAX_INGEST_BATCH = 50;

const httpsUrl = z.string().max(500).regex(/^https:\/\/[^\s]+$/, "must be an HTTPS URL");

/**
 * One crawled skill. Crawled names are always scoped to the repository's GitHub
 * owner (`@owner/skill`), so only that GitHub user can ever claim the listing.
 */
export const IngestSkillSchema = z
  .object({
    name: z.string().regex(PACKAGE_NAME_REGEX, "invalid package name"),
    description: z.string().trim().min(LIMITS.MIN_DESCRIPTION_LENGTH),
    license: z.string().regex(LICENSE_REGEX).default("NOASSERTION"),
    category: z.string().default("other"),
    keywords: z.array(z.string()).default([]),
    compatibility: z.array(z.string()).default([]),
    sourceUrl: httpsUrl,
    sourcePath: z.string().max(300).default(""),
    sourceSha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
    sourceOwner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/)
  })
  .refine((s) => s.name.startsWith("@") && s.name.slice(1).split("/")[0] === s.sourceOwner.toLowerCase(), {
    message: "name must be scoped to the repository owner (@owner/skill)"
  });

export const IngestBodySchema = z.object({
  skills: z.array(z.unknown()).min(1).max(MAX_INGEST_BATCH)
});

const COMPAT = new Set<string>(CompatibilityEnum.options);
const CATEGORIES = new Set<string>(CATEGORY_IDS);

export interface NormalizedIngestSkill {
  name: string;
  description: string;
  license: string;
  category: string;
  keywords: string[];
  compatibility: string[];
  sourceUrl: string;
  sourcePath: string;
  sourceSha: string | null;
  sourceOwner: string;
}

/** Clamp free-form crawler output into the shapes the rest of the registry expects. */
export function normalizeIngestSkill(input: z.infer<typeof IngestSkillSchema>): NormalizedIngestSkill {
  const keywords = Array.from(
    new Set(
      input.keywords
        .map((k) => k.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30))
        .filter(Boolean)
    )
  ).slice(0, LIMITS.MAX_KEYWORDS);
  return {
    name: input.name,
    description: input.description.slice(0, LIMITS.MAX_DESCRIPTION_LENGTH),
    license: input.license,
    category: CATEGORIES.has(input.category) ? input.category : "other",
    keywords,
    compatibility: input.compatibility.filter((c) => COMPAT.has(c)),
    sourceUrl: input.sourceUrl,
    sourcePath: input.sourcePath,
    sourceSha: input.sourceSha ?? null,
    sourceOwner: input.sourceOwner
  };
}
