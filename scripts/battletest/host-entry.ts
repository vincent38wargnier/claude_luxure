/** Battle-test bundle entry for host-side modules: transcript scanning and
 * the real LLM suggester (node-llama-cpp stays external / dynamic). Built by
 * run_all.py via esbuild into .host.mjs. */
export { loadPromptHistory } from "../../src/utils/promptHistory";
export { LlmSuggester } from "../../src/utils/llmSuggester";
export * from "../../src/shared/vocabWeights";
