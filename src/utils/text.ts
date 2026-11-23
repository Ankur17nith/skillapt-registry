/** Plain-text renderings for LLMs and agents: no JSON parsing needed. */

interface TextSkill {
  name: string;
  latestVersion: string;
  description: string;
  category: string;
  verified: boolean;
  claimStatus: string;
  downloads: number;
  installCommand: string;
}

export function formatSearchText(
  query: string,
  category: string | undefined,
  skills: TextSkill[],
  total: number
): string {
  const scope = [query ? `"${query}"` : "all skills", category ? `category ${category}` : ""]
    .filter(Boolean)
    .join(", ");
  if (skills.length === 0) {
    return `No skills found for ${scope}.\nTry fewer or different words, or list categories: skillapt categories\n`;
  }
  const lines = skills.map((s, i) => {
    const trust = s.verified ? "verified" : s.claimStatus === "unclaimed" ? "unclaimed" : "community";
    return [
      `${i + 1}. ${s.name}@${s.latestVersion} [${s.category}, ${trust}, ${s.downloads} downloads]`,
      `   ${s.description}`,
      `   install: ${s.installCommand}`
    ].join("\n");
  });
  const more = total > skills.length ? `\nShowing ${skills.length} of ${total}. Add &page=2 for more.\n` : "";
  return `Skills for ${scope}:\n\n${lines.join("\n\n")}\n${more}`;
}
