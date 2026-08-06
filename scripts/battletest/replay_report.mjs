/**
 * Merge all replay_*.json aggregates into one comparison table (markdown to
 * stdout) + a qualitative side-by-side sample dump for the named arms.
 *
 *   node replay_report.mjs [--samples 2b_current,4b_v3 --n 15]
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "results");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const files = fs
  .readdirSync(OUT_DIR)
  .filter((f) => f.startsWith("replay_") && f.endsWith(".json"))
  .sort();

const rows = [];
for (const f of files) {
  try {
    const { agg } = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf-8"));
    if (agg) rows.push(agg);
  } catch {
    /* skip */
  }
}

console.log("| arm | null% | next-word | LCP w | saved ch | F1 | mean ms | p95 ms |");
console.log("|---|---|---|---|---|---|---|---|");
for (const a of rows) {
  console.log(
    `| ${a.arm} | ${(a.nullRate * 100).toFixed(0)}% | ${(a.nextWordAcc * 100).toFixed(1)}% | ${a.meanLcp} | ${a.meanSavedChars} | ${a.meanF1} | ${a.meanMs} | ${a.p95Ms ?? "-"} |`
  );
}

const sampleArms = arg("samples", "");
if (sampleArms) {
  const n = Number(arg("n", "12"));
  const armFiles = sampleArms.split(",").map((a) => `replay_${a}.json`);
  const data = armFiles.map((f) =>
    JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf-8"))
  );
  console.log("\n## Side-by-side samples\n");
  const count = Math.min(n, data[0].results.length);
  const step = Math.max(1, Math.floor(data[0].results.length / count));
  for (let i = 0; i < data[0].results.length && i / step < count; i += step) {
    const base = data[0].results[i];
    console.log(`DRAFT : ${base.draft}`);
    console.log(`TRUTH : …${base.truth.slice(base.draft.length, base.draft.length + 90)}`);
    for (let d = 0; d < data.length; d++) {
      const r = data[d].results[i];
      const cont = r.suggestion ? r.suggestion.slice(Math.min(r.draft.trim().length, r.suggestion.length)) : "∅";
      console.log(`${armFiles[d].replace("replay_", "").replace(".json", "").padEnd(12)}: …${cont.slice(0, 90)}`);
    }
    console.log("");
  }
}
