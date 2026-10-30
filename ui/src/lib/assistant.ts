// The assistant's real course-policy memory and skills, read at build time from the files the sandboxed agent
// actually loads (workspace/MEMORY.md, workspace/skills/*/SKILL.md). Nothing here is hand-copied.
import memory from "../../../workspace/MEMORY.md?raw";
import regrade from "../../../workspace/skills/regrade/SKILL.md?raw";
import extension from "../../../workspace/skills/extension/SKILL.md?raw";

/** Bullets under one "## heading" of MEMORY.md, markdown stripped */
function section(heading: string): string[] {
  const m = new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(memory);
  return (m?.[1] ?? "").split("\n").map((l) => l.replace(/^\s*(?:-|\d+\.)\s+/, "").replace(/[*`]/g, "").trim()).filter((l) => l && !l.startsWith("#"));
}
export const COURSE = /^# Course policy memory: (.+)$/m.exec(memory)?.[1] ?? "";
export const POLICY_MEMORY: { topic: string; lines: string[] }[] = [
  { topic: "Regrades", lines: section("Regrades").slice(0, 2) },
  { topic: "Extensions", lines: section("Extensions").slice(0, 2) },
  { topic: "Privacy rules", lines: section("FERPA-aligned rules") },
];

function skill(md: string) {
  const name = /^name:\s*(.+)$/m.exec(md)?.[1].trim() ?? "";
  const description = /^description:\s*(.+)$/m.exec(md)?.[1].trim() ?? "";
  return { name, description };
}
export const SKILLS = [skill(regrade), skill(extension)];
