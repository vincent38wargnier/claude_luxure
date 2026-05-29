import * as path from "path";

export function convertToMentionPath(
  absolutePath: string,
  workspacePath: string
): string {
  let relative = path.relative(workspacePath, absolutePath);
  relative = relative.replace(/\\/g, "/");
  return `@/${relative}`;
}

export function resolveFromMention(
  mention: string,
  workspacePath: string
): string {
  const cleaned = mention.replace(/^@\/?/, "");
  return path.resolve(workspacePath, cleaned);
}

export function extractMentions(text: string): string[] {
  const regex = /@\/([\w.\/\-\\]+)/g;
  const mentions: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    mentions.push(match[0]);
  }
  return mentions;
}

export function stripFileProtocol(uri: string): string {
  if (uri.startsWith("file://")) {
    return decodeURIComponent(uri.slice(7));
  }
  if (uri.startsWith("vscode-remote://")) {
    const idx = uri.indexOf("/", "vscode-remote://".length);
    if (idx !== -1) {
      return decodeURIComponent(uri.slice(idx));
    }
  }
  return uri;
}
