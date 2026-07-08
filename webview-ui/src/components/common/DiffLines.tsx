import type { ReactNode } from "react";

/** Shared diff-line renderer (used by FileChangeCard previews and the Review
 * panel). Expects two-char prefixes — "+ ", "- ", "  " — so every line's
 * content sits in the same column; "@@" hunk headers render dimmed blue. */
export function CodeLine({ line }: { line: string }) {
  // Cursor-style diff: muted tint + left bar on changed lines, syntax colors
  // preserved inside, context left uncolored.
  if (line.startsWith("@@")) {
    return <div className="px-2.5 text-[#6b9fd8] opacity-70">{line}</div>;
  }
  const isAdd = line.startsWith("+") && !line.startsWith("+++");
  const isDel = line.startsWith("-") && !line.startsWith("---");
  if (isAdd) {
    // Warm olive tint (Cursor), green left bar, syntax colors kept.
    return (
      <div className="border-l-2 border-[#5a8a3a] bg-[#3e3b2a] pl-2 pr-2.5">
        <span className="select-none text-[#7fae5a] opacity-80">+ </span>
        {highlightSyntax(line.slice(2))}
      </div>
    );
  }
  if (isDel) {
    // Lighter maroon tint, muted (not crimson) red bar.
    return (
      <div className="border-l-2 border-[#4b1918] bg-[#471b18] pl-2 pr-2.5">
        <span className="select-none text-[#e0817c] opacity-80">- </span>
        {highlightSyntax(line.slice(2))}
      </div>
    );
  }
  return (
    <div className="border-l-2 border-transparent pl-2 pr-2.5 opacity-90">
      {highlightSyntax(line)}
    </div>
  );
}

/** Normalize a raw unified patch (jsdiff createPatch output) into CodeLine's
 * two-char-prefix format: header lines dropped, single-char +/-/space prefixes
 * widened so content aligns across changed and context lines. */
export function patchToCodeLines(patch: string): string[] {
  const lines = patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  const body = start >= 0 ? lines.slice(start) : lines;
  return body.map((l) => {
    if (l.startsWith("@@") || l === "") {
      return l;
    }
    if (l.startsWith("+")) {
      return "+ " + l.slice(1);
    }
    if (l.startsWith("-")) {
      return "- " + l.slice(1);
    }
    if (l.startsWith(" ")) {
      return " " + l; // context: one space in the patch → two-space column
    }
    return l; // "\ No newline at end of file" and friends
  });
}

function highlightSyntax(line: string): ReactNode {
  const parts: ReactNode[] = [];
  let remaining = line;
  let key = 0;

  const rules: [RegExp, string][] = [
    [/^(import|export|from|const|let|var|function|class|interface|type|return|async|await|if|else|for|while|switch|case|break|default|new|throw|try|catch|extends|implements)\b/, "#c586c0"],
    [/"[^"]*"|'[^']*'|`[^`]*`/, "#ce9178"],
    [/\/\/.*$/, "#6a9955"],
    [/\b(true|false|null|undefined|void)\b/, "#569cd6"],
    [/\b\d+(\.\d+)?\b/, "#b5cea8"],
    [/\{|\}|\(|\)|\[|\]/, "#ffd700"],
  ];

  while (remaining.length > 0) {
    let matched = false;
    for (const [regex, color] of rules) {
      const match = remaining.match(regex);
      if (match && match.index !== undefined) {
        if (match.index > 0) {
          parts.push(
            <span key={key++}>{remaining.slice(0, match.index)}</span>
          );
        }
        parts.push(
          <span key={key++} style={{ color }}>
            {match[0]}
          </span>
        );
        remaining = remaining.slice(match.index + match[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
  }

  return <>{parts}</>;
}
