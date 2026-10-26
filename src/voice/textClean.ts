/** Turn an assistant reply (markdown) into plain text worth hearing.
 * Ported from claude-voice's `text_clean.rs`, with one fix: markdown emphasis
 * markers are only stripped at word edges, so `snake_case_name` and
 * `a*b` survive intact instead of being mangled. */
export function cleanForSpeech(input: string): string {
  let s = input.replace(/\r\n?/g, "\n");

  // Fenced code blocks are shown, never spoken.
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, " ");
  // Images vanish; links keep their label.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs are noise when read aloud.
  s = s.replace(/<?\bhttps?:\/\/[^\s>)]+>?/g, " ");
  // Inline code keeps its content.
  s = s.replace(/`([^`\n]*)`/g, "$1");
  // HTML tags.
  s = s.replace(/<\/?[a-zA-Z][^>\n]*>/g, " ");

  const lines = s.split("\n").map((line) => {
    let l = line;
    // Tables: drop separator rows, turn pipes into pauses.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)) {
      return "";
    }
    if (l.includes("|")) {
      l = l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").replace(/\s*\|\s*/g, ", ");
    }
    // Horizontal rules.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      return "";
    }
    // Headings, blockquotes, list bullets, task boxes.
    l = l.replace(/^\s*#{1,6}\s+/, "");
    l = l.replace(/^\s*(>\s*)+/, "");
    l = l.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, "");
    // A line that ends without punctuation (heading, bullet) gets a pause.
    if (l.trim() && !/[.!?:;,]\s*$/.test(l)) {
      l = l.replace(/\s*$/, ".");
    }
    return l;
  });
  s = lines.join("\n");

  // Emphasis / strike markers, only where they hug a word edge.
  s = s.replace(/(^|[\s(])(\*{1,3}|_{1,3}|~~)(?=\S)/g, "$1");
  s = s.replace(/(\S)(\*{1,3}|_{1,3}|~~)(?=[\s).,!?:;]|$)/g, "$1");

  return s.replace(/\s+/g, " ").trim();
}
