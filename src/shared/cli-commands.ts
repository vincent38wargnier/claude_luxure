export interface CliCommand {
  name: string;
  description: string;
  extension?: boolean;
}

export const SUMMARIZE_COMPACT_PROMPT = `Summarize what has been done through this conversation. List all the tools used (don't repeat individual tool calls — group by tool name and give counts). Include a very detailed summary of the last 20 messages of the chat so we don't lose the context of the recent messages.`;

export const DEFAULT_CLI_COMMANDS: CliCommand[] = [
  { name: "/summarize", description: "Summarize conversation and compact context", extension: true },
  { name: "/compact", description: "Free up context by summarizing the conversation" },
  { name: "/clear", description: "Start a new conversation with empty context" },
  { name: "/context", description: "Show current context usage" },
  { name: "/cost", description: "Show session cost and usage" },
  { name: "/model", description: "Switch the AI model" },
  { name: "/effort", description: "Set model effort level" },
  { name: "/plan", description: "Enter plan mode" },
  { name: "/branch", description: "Branch the current conversation" },
  { name: "/resume", description: "Resume a previous conversation" },
  { name: "/rename", description: "Rename the current session" },
  { name: "/rewind", description: "Rewind conversation or code to a checkpoint" },
  { name: "/export", description: "Export conversation as plain text" },
  { name: "/diff", description: "View uncommitted and per-turn diffs" },
  { name: "/code-review", description: "Review the current diff for bugs" },
  { name: "/review", description: "Review a pull request locally" },
  { name: "/security-review", description: "Analyze changes for security issues" },
  { name: "/agents", description: "Manage agent configurations" },
  { name: "/tasks", description: "List and manage background tasks" },
  { name: "/background", description: "Detach session to run in background" },
  { name: "/mcp", description: "Manage MCP server connections" },
  { name: "/reload-skills", description: "Re-scan skill directories without restarting" },
  { name: "/skills", description: "List available skills" },
  { name: "/memory", description: "Edit CLAUDE.md memory files" },
  { name: "/init", description: "Initialize project with CLAUDE.md" },
  { name: "/permissions", description: "Manage tool permission rules" },
  { name: "/config", description: "Open settings" },
  { name: "/doctor", description: "Diagnose Claude Code installation" },
  { name: "/debug", description: "Enable debug logging" },
  { name: "/help", description: "Show help and available commands" },
  { name: "/btw", description: "Ask a side question without adding to history" },
  { name: "/recap", description: "Generate a one-line session summary" },
  { name: "/stop", description: "Stop the current background session" },
];

export function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

export function isCompactCommand(text: string): boolean {
  const trimmed = text.trim();
  return /^\/(compact|summarize)\b/i.test(trimmed);
}

export function resolveSlashCommand(text: string): {
  displayText: string;
  cliText: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { displayText: text, cliText: text };
  }

  const match = trimmed.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { displayText: text, cliText: text };
  }

  const cmd = match[1].toLowerCase();
  const args = match[2]?.trim() || "";

  if (cmd === "summarize") {
    const prompt = args
      ? `${SUMMARIZE_COMPACT_PROMPT}\n\nAdditional focus: ${args}`
      : SUMMARIZE_COMPACT_PROMPT;
    return { displayText: trimmed, cliText: `/compact ${prompt}` };
  }

  return { displayText: trimmed, cliText: trimmed };
}

export function mergeCliCommands(
  dynamicNames: string[] | undefined
): CliCommand[] {
  const byName = new Map<string, CliCommand>();

  for (const cmd of DEFAULT_CLI_COMMANDS) {
    byName.set(cmd.name, cmd);
  }

  if (dynamicNames) {
    for (const name of dynamicNames) {
      if (!name.startsWith("/")) {
        continue;
      }
      if (!byName.has(name)) {
        byName.set(name, { name, description: "Claude Code command" });
      }
    }
  }

  const summarize = byName.get("/summarize")!;
  byName.delete("/summarize");

  return [summarize, ...Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))];
}
