#!/usr/bin/env python3
"""One-command battle test for the composer suggestion stack.

    python3 scripts/battletest/run_all.py [--n 3000] [--seed 7] [--skip-llm]

Steps:
  1. bundle the REAL production TS (webview + host) with esbuild
  2. property self-tests (mirror parity, attribution, phrases, weights, perf)
  3. Python-driven simulation of N scenarios (learning / phrases / jargon)
  4. real-LLM A/B bench: Qwen3.5-2B with vs without vocabulary steering
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent.parent


def step(name, cmd, timeout=1800):
    print(f"\n━━━ {name} ━━━")
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=REPO, timeout=timeout)
    dt = time.time() - t0
    ok = proc.returncode == 0
    print(f"━━━ {name}: {'PASS' if ok else f'FAIL (rc={proc.returncode})'} in {dt:.1f}s ━━━")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--skip-llm", action="store_true")
    args = ap.parse_args()

    results = {}
    results["bundle core"] = step("bundle core (webview logic)", [
        "npx", "esbuild", "scripts/battletest/core-entry.ts", "--bundle",
        "--format=esm", "--outfile=scripts/battletest/.core.mjs",
        "--log-level=warning",
    ])
    results["bundle host"] = step("bundle host (scanner + LLM suggester)", [
        "npx", "esbuild", "scripts/battletest/host-entry.ts", "--bundle",
        "--format=cjs", "--platform=node",
        "--outfile=scripts/battletest/.host.cjs", "--log-level=warning",
    ])
    if not all(results.values()):
        return 1

    results["selftest"] = step("property self-tests", [
        "node", "scripts/battletest/runner.mjs", "--selftest",
    ])
    results["simulation"] = step(f"simulation ({args.n} scenarios)", [
        sys.executable, "scripts/battletest/simulate.py",
        "--n", str(args.n), "--seed", str(args.seed),
    ])
    if not args.skip_llm:
        results["llm bench"] = step("real-LLM A/B bench", [
            "node", "scripts/battletest/llm_bench.mjs",
        ], timeout=900)

    print("\n═══ battle-test verdict ═══")
    for name, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
