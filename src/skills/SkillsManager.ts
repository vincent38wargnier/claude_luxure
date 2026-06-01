import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SkillInfo, SkillScope } from "../shared/types";

const SKILL_FILE = "SKILL.md";
const SKILL_NAME_REGEX = /^[a-z0-9-]+$/;

const NEW_SKILL_TEMPLATE = (name: string) => `---
description: What this skill does and when Claude should use it.
---

## Instructions

(Paste your workflow here.)
`;

function globalSkillsRoot(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function projectSkillsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "skills");
}

function parseSkillId(skillId: string): { scope: SkillScope; folder: string } {
  const colon = skillId.indexOf(":");
  if (colon === -1) {
    throw new Error(`Invalid skill id: ${skillId}`);
  }
  const scope = skillId.slice(0, colon) as SkillScope;
  const folder = skillId.slice(colon + 1);
  if (scope !== "global" && scope !== "project") {
    throw new Error(`Invalid skill scope: ${scope}`);
  }
  if (!folder) {
    throw new Error(`Invalid skill id: ${skillId}`);
  }
  return { scope, folder };
}

function skillPath(scope: SkillScope, folder: string, workspaceRoot?: string): string {
  const root =
    scope === "global"
      ? globalSkillsRoot()
      : projectSkillsRoot(workspaceRoot!);
  return path.join(root, folder, SKILL_FILE);
}

function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const block = match[1];
  const result: { name?: string; description?: string } = {};
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (nameMatch) {
    result.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
  }
  const descMatch = block.match(/^description:\s*>?-?\s*([\s\S]*?)(?=^[a-zA-Z_-]+:|$)/m);
  if (descMatch) {
    result.description = descMatch[1]
      .replace(/\n\s+/g, " ")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return result;
}

function scanSkillsDir(
  skillsDir: string,
  scope: SkillScope
): SkillInfo[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: SkillInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillMdPath = path.join(skillsDir, entry.name, SKILL_FILE);
    if (!fs.existsSync(skillMdPath)) {
      continue;
    }

    let content = "";
    try {
      content = fs.readFileSync(skillMdPath, "utf-8");
    } catch {
      continue;
    }

    const meta = parseFrontmatter(content);
    const folderName = entry.name;

    skills.push({
      id: `${scope}:${folderName}`,
      scope,
      command: `/${folderName}`,
      name: meta.name || folderName,
      description: meta.description,
      path: skillMdPath,
    });
  }

  return skills.sort((a, b) => a.command.localeCompare(b.command));
}

export class SkillsManager {
  listSkills(workspaceRoot?: string): SkillInfo[] {
    const global = scanSkillsDir(globalSkillsRoot(), "global");
    const project = workspaceRoot
      ? scanSkillsDir(projectSkillsRoot(workspaceRoot), "project")
      : [];
    return [...global, ...project];
  }

  readSkill(skillId: string, workspaceRoot?: string): string {
    const { scope, folder } = parseSkillId(skillId);
    const filePath = skillPath(scope, folder, workspaceRoot);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    return fs.readFileSync(filePath, "utf-8");
  }

  writeSkill(
    skillId: string,
    content: string,
    workspaceRoot?: string
  ): void {
    const { scope, folder } = parseSkillId(skillId);
    const filePath = skillPath(scope, folder, workspaceRoot);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    fs.writeFileSync(filePath, content, "utf-8");
  }

  createSkill(
    scope: SkillScope,
    name: string,
    workspaceRoot?: string
  ): SkillInfo {
    const normalized = name.trim().toLowerCase();
    if (!SKILL_NAME_REGEX.test(normalized)) {
      throw new Error(
        "Skill name must contain only lowercase letters, numbers, and hyphens"
      );
    }

    const root =
      scope === "global"
        ? globalSkillsRoot()
        : projectSkillsRoot(workspaceRoot!);

    if (scope === "project" && !workspaceRoot) {
      throw new Error("No workspace folder open for project skills");
    }

    const skillDir = path.join(root, normalized);
    const filePath = path.join(skillDir, SKILL_FILE);

    if (fs.existsSync(skillDir)) {
      throw new Error(`Skill already exists: /${normalized}`);
    }

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(filePath, NEW_SKILL_TEMPLATE(normalized), "utf-8");

    return {
      id: `${scope}:${normalized}`,
      scope,
      command: `/${normalized}`,
      name: normalized,
      description: "What this skill does and when Claude should use it.",
      path: filePath,
    };
  }

  deleteSkill(skillId: string, workspaceRoot?: string): void {
    const { scope, folder } = parseSkillId(skillId);
    const skillDir = path.dirname(skillPath(scope, folder, workspaceRoot));
    if (!fs.existsSync(skillDir)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  validateSkillName(name: string): boolean {
    return SKILL_NAME_REGEX.test(name.trim().toLowerCase());
  }
}
