/** Battle-test bundle entry: the REAL webview suggestion logic (ranking,
 * phrase chunking, vocab weights, provenance) exposed to node. Built by
 * run_all.py via esbuild into .core.mjs — never edit that output. */
export * from "../../webview-ui/src/utils/promptSuggestions";
export * from "../../webview-ui/src/utils/vocabWeights";
