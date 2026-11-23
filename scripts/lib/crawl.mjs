// Pure helpers for the GitHub crawler. No network access here, so they are unit-tested.
import yaml from "yaml";

const NAME_RE = /^(@[a-z0-9-]{2,30}\/)?[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/** Category rules: first match wins, checked against name + description + topics. */
const CATEGORY_RULES = [
  ["security", /\b(security|vulnerab|pentest|owasp|cve|secrets?|audit)\b/],
  ["testing", /\b(test|testing|qa|e2e|playwright|jest|pytest|debug|accessibility)\b/],
  ["devops", /\b(devops|deploy|docker|kubernetes|k8s|terraform|ci\/cd|cicd|aws|gcp|azure|cloudflare)\b/],
  ["database", /\b(sql|postgres|mysql|sqlite|database|schema|migration|mongodb|redis)\b/],
  ["ai-agents", /\b(mcp|agent|agents|prompt|prompts|llm|rag|eval|evals)\b/],
  ["documents", /\b(pdf|docx|word|powerpoint|pptx|xlsx|excel|spreadsheet|slides|document)\b/],
  ["data", /\b(data|analytics|csv|pandas|chart|dashboard|visuali[sz]ation)\b/],
  ["design", /\b(design|ui|ux|figma|css|tailwind|layout|frontend)\b/],
  ["media", /\b(image|images|audio|video|music|photo|illustration)\b/],
  ["marketing", /\b(seo|marketing|campaign|social media|growth|newsletter)\b/],
  ["finance", /\b(finance|invoice|accounting|payment|stripe|shopify|ecommerce|e-commerce)\b/],
  ["education", /\b(learn|learning|teach|tutor|quiz|course|education)\b/],
  ["communication", /\b(email|slack|discord|meeting|chat|notification)\b/],
  ["automation", /\b(automation|automate|scrape|scraper|cron|workflow|browser)\b/],
  ["research", /\b(research|search|sources|citations?|summari[sz]e web)\b/],
  ["writing", /\b(writing|write|blog|article|copywriting|translate|translation|docs?)\b/],
  ["productivity", /\b(notes?|todo|tasks?|calendar|planning|productivity)\b/],
  ["devtools", /\b(git|github|commit|changelog|lint|cli|build|release|npm|refactor)\b/],
  ["coding", /\b(code|coding|programming|typescript|python|rust|golang|java|javascript|function)\b/]
];

export function classify(text) {
  const haystack = String(text || "").toLowerCase();
  for (const [category, re] of CATEGORY_RULES) {
    if (re.test(haystack)) return category;
  }
  return "other";
}

/** Returns the YAML frontmatter object of a SKILL.md, or null. */
export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(markdown || ""));
  if (!match) return null;
  try {
    const data = yaml.parse(match[1]);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

/** Crawled names are always `@<github-owner>/<skill>`; returns null when no valid name fits. */
export function toSkillName(owner, frontmatterName, dirName) {
  const scope = slugify(owner).slice(0, 30);
  const skill = slugify(frontmatterName) || slugify(dirName);
  if (scope.length < 2 || !skill) return null;
  const name = `@${scope}/${skill}`;
  return NAME_RE.test(name) ? name : null;
}

/** True when the author or the registry has asked not to be indexed. */
export function isOptedOut(frontmatter, owner, optOutOwners = []) {
  if (frontmatter && (frontmatter.skillapt === false || frontmatter["skillapt-index"] === false)) return true;
  return optOutOwners.map((o) => o.toLowerCase()).includes(String(owner).toLowerCase());
}

const KNOWN_TARGETS = ["claude", "cursor", "codex", "antigravity", "openai"];

/**
 * Build one ingest entry from a SKILL.md and its repository metadata, or return
 * { skip: reason }. Only metadata and a link are produced, never the file body.
 */
export function toIngestEntry({ repo, path, sha, markdown, optOutOwners = [] }) {
  const owner = repo.owner;
  if (repo.fork) return { skip: "fork" };
  if (repo.archived) return { skip: "archived" };
  const fm = parseFrontmatter(markdown);
  if (!fm) return { skip: "no frontmatter" };
  if (isOptedOut(fm, owner, optOutOwners)) return { skip: "opted out" };

  const description = typeof fm.description === "string" ? fm.description.replace(/\s+/g, " ").trim() : "";
  if (description.length < 10) return { skip: "no description" };

  const dir = path.split("/").slice(-2, -1)[0] || repo.name;
  const frontName = typeof fm.name === "string" ? fm.name : "";
  const name = toSkillName(owner, frontName, dir);
  if (!name) return { skip: "invalid name" };

  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  const keywords = [...topics, ...(Array.isArray(fm.keywords) ? fm.keywords.map(String) : [])];
  const text = `${frontName} ${dir} ${description} ${topics.join(" ")}`;
  const mentioned = KNOWN_TARGETS.filter((t) => text.toLowerCase().includes(t));

  return {
    entry: {
      name,
      description,
      license: repo.license || "NOASSERTION",
      category: classify(text),
      keywords,
      compatibility: mentioned.length ? mentioned : ["claude"],
      sourceUrl: repo.url,
      sourcePath: path.replace(/\/?SKILL\.md$/, ""),
      sourceSha: sha,
      sourceOwner: owner
    }
  };
}
