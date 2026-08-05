#!/usr/bin/env python3
"""Battle-test simulator for the composer suggestion stack.

Generates thousands of synthetic-but-realistic usage scenarios (sessions of
prompts being sent, with keystroke probes in between), executes them through
the REAL production TypeScript logic (bundled by esbuild, run in node via
runner.mjs), and validates that the auto-learning behaves:

  1. LEARNING   — a prompt sent twice becomes the #1 suggestion for its prefix.
  2. PHRASES    — a phrase buried inside a long prompt is retrievable as its
                  own insertable suggestion (two-granularity RAG).
  3. JARGON     — project-specific words gain weight fast and flip ranking
                  decisions against recency (corrector-style personalization).
  4. WEIGHTS    — learned jargon weights dominate common-English weights.

Usage:  python3 simulate.py --n 2000 --seed 7
"""
import argparse
import json
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).parent
DAY_MS = 86_400_000

JARGON_POOL = [
    "glorbex", "zintra", "quathe", "brimvel", "stellax", "frodune",
    "klemvar", "ostrine", "dulcify", "yarrock", "pentrose", "vexlow",
    "murbine", "tazzle", "wrenlok", "cindral",
]
# First words reserved for the designated learning prompt so its prefix is
# unambiguous (competing prompts never start with these).
LEARNING_VERBS = ["annotate", "benchmark", "migrate", "instrument", "profile"]
GENERIC_NOUNS = ["settings", "layout", "footer", "sidebar", "toolbar", "modal"]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def make_scenario(sc_id: int, rnd: random.Random, now_ms: int) -> dict:
    jargon = rnd.sample(JARGON_POOL, k=rnd.randint(4, 6))
    j1, j2 = jargon[0], jargon[1]

    # --- prompt pool -----------------------------------------------------
    learning_verb = rnd.choice(LEARNING_VERBS)
    learning_prompt = f"{learning_verb} the {jargon[2]} flow end to end"
    long_prompt = (
        f"the {j1} view still flickers when switching tabs. "
        f"run the {j2} suite and capture a fresh trace. "
        f"also make sure the layout state persists after reload."
    )
    buried_sub = f"run the {j2} suite and capture"

    fillers = [
        f"check the {j1} logs",
        f"fix the {j1} gate quickly",
        f"restart the {j1} worker",
        f"add a {rnd.choice(jargon)} badge to the {rnd.choice(GENERIC_NOUNS)}",
        f"can you clean the {rnd.choice(GENERIC_NOUNS)} spacing",
        f"show the {rnd.choice(jargon)} counters in the {rnd.choice(GENERIC_NOUNS)}",
        f"take a screenshot of the {rnd.choice(GENERIC_NOUNS)}",
    ]

    # --- send schedule: 3-5 sessions, learning prompt repeats ------------
    sends: list[str] = []
    n_sessions = rnd.randint(3, 5)
    learning_sends: list[int] = []  # send-count AFTER each learning send
    long_sent_at = None
    for s in range(n_sessions):
        session_prompts = rnd.sample(fillers, k=rnd.randint(2, 4))
        if s == 0:
            session_prompts.insert(rnd.randrange(len(session_prompts) + 1), long_prompt)
        # learning prompt goes out in most sessions (that's the repetition)
        if s < n_sessions - 1 or rnd.random() < 0.5:
            session_prompts.append(learning_prompt)
        for p in session_prompts:
            sends.append(p)
            if p == learning_prompt:
                learning_sends.append(len(sends))
            if p == long_prompt and long_sent_at is None:
                long_sent_at = len(sends)

    # --- probes -----------------------------------------------------------
    probes = []
    ln = norm(learning_prompt)
    # before any send (baseline), and after each send of the learning prompt
    probes.append({
        "kind": "learning", "afterSend": 0, "sends": 0,
        "draft": learning_prompt[:8], "targetNorm": ln,
    })
    for i, at in enumerate(learning_sends):
        for dlen in (8, 12):
            probes.append({
                "kind": "learning", "afterSend": at, "sends": i + 1,
                "draft": learning_prompt[:dlen], "targetNorm": ln,
            })

    if long_sent_at is not None:
        probe_at = min(long_sent_at + rnd.randint(1, 3), len(sends))
        for dlen in (7, 11):
            probes.append({
                "kind": "phrase", "afterSend": probe_at,
                "draft": f"run the {j2}"[:dlen], "targetSub": buried_sub,
            })

    # --- jargon A/B: seeded aged entries + a decisive probe ----------------
    jargon_prompt = f"update the {j1} pipeline weights"
    generic_prompt = "update the same thing again please"
    seed_entries = [
        {"text": jargon_prompt, "count": 2, "lastUsed": now_ms - 3 * DAY_MS},
        {"text": generic_prompt, "count": 1, "lastUsed": now_ms - 600_000},
    ]

    # --- adversarial noise: a realistic aged history the ranking must dig
    # through (other jargon, colliding verbs, competing "run the" prompts) --
    other_jargon = [w for w in JARGON_POOL if w != j2]
    distractor_templates = [
        lambda: f"check the {rnd.choice(other_jargon)} logs for the {rnd.choice(GENERIC_NOUNS)}",
        lambda: f"fix the {rnd.choice(other_jargon)} gate in the {rnd.choice(GENERIC_NOUNS)}",
        lambda: f"run the {rnd.choice(other_jargon)} suite and capture a fresh trace",
        lambda: f"add a {rnd.choice(other_jargon)} pill to the {rnd.choice(GENERIC_NOUNS)}",
        lambda: f"take a screenshot of the {rnd.choice(GENERIC_NOUNS)} after reload",
        lambda: f"why does the {rnd.choice(other_jargon)} {rnd.choice(GENERIC_NOUNS)} flicker",
        lambda: (
            f"the {rnd.choice(other_jargon)} import fails on start. "
            f"trace the {rnd.choice(other_jargon)} loader and log every step. "
            f"then verify the {rnd.choice(GENERIC_NOUNS)} renders."
        ),
    ]
    for _ in range(rnd.randint(120, 300)):
        seed_entries.append({
            "text": rnd.choice(distractor_templates)(),
            "count": rnd.randint(1, 3),
            "lastUsed": now_ms - rnd.randint(7, 180) * DAY_MS,
        })
    # prefix-collision pressure on the learning probe's exact draft
    seed_entries.append({
        "text": f"{learning_verb} the {rnd.choice(GENERIC_NOUNS)} quickly",
        "count": 2,
        "lastUsed": now_ms - 30 * DAY_MS,
    })
    # probe once ≥3 j1-bearing sends have happened (fillers 0-2 carry j1)
    j1_sends = [i + 1 for i, p in enumerate(sends) if j1 in p]
    if len(j1_sends) >= 3:
        probes.append({
            "kind": "jargon", "afterSend": j1_sends[2],
            "draft": "update the ",
            "jargonNorm": norm(jargon_prompt),
            "genericNorm": norm(generic_prompt),
        })

    return {
        "id": sc_id,
        "seedEntries": seed_entries,
        "sends": sends,
        "probes": probes,
        "jargonWords": jargon,
    }


def run_batch(scenarios: list[dict], runner: Path) -> list[dict]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"scenarios": scenarios}, f)
        batch_path = f.name
    try:
        proc = subprocess.run(
            ["node", str(runner), "--scenarios", batch_path],
            capture_output=True, text=True, timeout=600,
        )
        if proc.returncode != 0:
            print(proc.stderr, file=sys.stderr)
            raise RuntimeError(f"runner failed rc={proc.returncode}")
        return json.loads(proc.stdout)["results"]
    finally:
        Path(batch_path).unlink(missing_ok=True)


def rate(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--batch", type=int, default=500)
    ap.add_argument("--report", default=str(HERE / "results" / "simulation_report.json"))
    args = ap.parse_args()

    rnd = random.Random(args.seed)
    now_ms = int(time.time() * 1000)
    runner = HERE / "runner.mjs"

    print(f"generating {args.n} scenarios (seed={args.seed}) …")
    scenarios = [make_scenario(i, rnd, now_ms) for i in range(args.n)]

    results = []
    t0 = time.time()
    for i in range(0, len(scenarios), args.batch):
        chunk = scenarios[i : i + args.batch]
        results.extend(run_batch(chunk, runner))
        print(f"  executed {min(i + args.batch, len(scenarios))}/{len(scenarios)}")
    wall = time.time() - t0

    # ------------------------------------------------------------- metrics
    learn0, learn1, learn2 = [], [], []   # rank lists by sends bucket
    learn2_top5 = []
    phrase_row_top5, any_with, any_without = [], [], []
    flips, baselines = [], []
    weight_ok = []
    n_probes = 0

    for r in results:
        if r["meanJargonWeight"] is not None and r["meanCommonWeight"] is not None:
            weight_ok.append(r["meanJargonWeight"] > r["meanCommonWeight"])
        for p in r["probes"]:
            n_probes += 1
            if p["kind"] == "learning":
                if p["sends"] == 0:
                    learn0.append(p["rank"] == 0)
                elif p["sends"] == 1:
                    learn1.append(p["rank"] == 0)
                else:
                    learn2.append(p["rank"] == 0)
                    learn2_top5.append(0 <= p["rank"] < 5)
            elif p["kind"] == "phrase":
                phrase_row_top5.append(0 <= p["phraseRowRank"] < 5)
                any_with.append(0 <= p["anyRowRank"] < 5)
                any_without.append(0 <= p["promptsOnlyRank"] < 5)
            elif p["kind"] == "jargon":
                flips.append(p["withVocabPicksJargon"])
                baselines.append(p["noVocabPicksGeneric"])

    metrics = {
        "scenarios": len(results),
        "probes": n_probes,
        "wall_seconds": round(wall, 1),
        "learning": {
            "top1_before_any_send": rate(learn0),
            "top1_after_1_send": rate(learn1),
            "top1_after_2plus_sends": rate(learn2),
            "top5_after_2plus_sends": rate(learn2_top5),
        },
        "phrases": {
            "phrase_row_in_top5": rate(phrase_row_top5),
            "any_row_in_top5_with_phrases": rate(any_with),
            "any_row_in_top5_prompts_only": rate(any_without),
        },
        "jargon": {
            "vocab_flips_to_jargon": rate(flips),
            "baseline_prefers_generic": rate(baselines),
            "probe_count": len(flips),
        },
        "weights": {"jargon_gt_common_rate": rate(weight_ok)},
    }

    checks = [
        ("learning: top1 after 2+ sends ≥ 0.90", metrics["learning"]["top1_after_2plus_sends"] >= 0.90),
        ("learning: top5 after 2+ sends ≥ 0.98", metrics["learning"]["top5_after_2plus_sends"] >= 0.98),
        ("learning: improves with repetition (Δ ≥ 0.15)",
         metrics["learning"]["top1_after_2plus_sends"] - metrics["learning"]["top1_after_1_send"] >= 0.15
         or metrics["learning"]["top1_after_1_send"] >= 0.85),
        ("phrases: buried phrase row in top5 ≥ 0.85", metrics["phrases"]["phrase_row_in_top5"] >= 0.85),
        ("phrases: no regression vs prompts-only",
         metrics["phrases"]["any_row_in_top5_with_phrases"] >= metrics["phrases"]["any_row_in_top5_prompts_only"] - 0.02),
        ("jargon: vocab flips ranking ≥ 0.70", metrics["jargon"]["vocab_flips_to_jargon"] >= 0.70),
        ("jargon: baseline validity ≥ 0.60", metrics["jargon"]["baseline_prefers_generic"] >= 0.60),
        ("weights: jargon > common in ≥ 0.99", metrics["weights"]["jargon_gt_common_rate"] >= 0.99),
    ]

    print("\n=== simulation metrics ===")
    print(json.dumps(metrics, indent=2))
    print("\n=== assertions ===")
    failed = 0
    for name, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        failed += 0 if ok else 1

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(
        {"metrics": metrics, "checks": [{"name": n, "ok": o} for n, o in checks],
         "n": args.n, "seed": args.seed}, indent=2))
    print(f"\nreport → {report_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
