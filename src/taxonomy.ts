/**
 * Skill categories: what a skill is for. Each has a short description so that
 * both people and LLM agents can pick the right one. "other" stays last.
 */
export interface CategoryInfo {
  id: string;
  label: string;
  description: string;
}

export const CATEGORIES: readonly CategoryInfo[] = [
  { id: "documents", label: "Documents", description: "Create, read, convert or summarise PDFs, Word, slides, spreadsheets and other files." },
  { id: "coding", label: "Coding", description: "Write, refactor, review or explain source code in any language." },
  { id: "testing", label: "Testing & QA", description: "Generate tests, debug failures, check quality and accessibility." },
  { id: "devtools", label: "Developer tools", description: "Git, build tools, linters, CLIs, editors and release workflows." },
  { id: "devops", label: "DevOps & cloud", description: "Deploy, monitor and operate infrastructure, containers, CI/CD and cloud services." },
  { id: "database", label: "Databases", description: "Design schemas, write queries, run migrations and inspect data stores." },
  { id: "data", label: "Data & analytics", description: "Clean, analyse and visualise data, build reports and dashboards." },
  { id: "research", label: "Research", description: "Search the web, gather sources, compare options and write findings." },
  { id: "writing", label: "Writing & content", description: "Draft, edit, translate and format articles, docs and copy." },
  { id: "design", label: "Design & UI", description: "Design interfaces, generate assets, apply design systems and layouts." },
  { id: "security", label: "Security", description: "Audit code and dependencies, find vulnerabilities, manage secrets safely." },
  { id: "automation", label: "Automation", description: "Run repetitive tasks, scrape pages, schedule jobs and glue services together." },
  { id: "ai-agents", label: "AI agents & prompts", description: "Build agents, MCP servers, prompts, evals and multi-agent workflows." },
  { id: "communication", label: "Communication", description: "Email, chat, meetings, notifications and customer messaging." },
  { id: "productivity", label: "Productivity", description: "Notes, tasks, calendars, planning and personal workflows." },
  { id: "marketing", label: "Marketing & SEO", description: "Campaigns, SEO, analytics, social posts and growth tasks." },
  { id: "finance", label: "Finance & business", description: "Accounting, invoices, reports, e-commerce and business operations." },
  { id: "education", label: "Education", description: "Teach, tutor, make quizzes and learning material." },
  { id: "media", label: "Media", description: "Images, audio, video and creative generation." },
  { id: "other", label: "Other", description: "Skills that do not fit any other category." }
] as const;

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [string, ...string[]];
