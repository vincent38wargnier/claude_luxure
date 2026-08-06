/** Battle-test bundle entry for host-side modules: transcript scanning and
 * the real LLM suggester (node-llama-cpp stays external / dynamic). Built by
 * run_all.py via esbuild into .host.mjs. */
export { loadPromptHistory } from "../../src/utils/promptHistory";
export {
  LlmSuggester,
  mergeDraftAndContinuation,
  truncateAtConfidence,
  wordsWithConfidence,
  CONF_CANDIDATE_FLOOR,
  CONF_EXTEND_FLOOR,
  MAGIE_MAX_ROWS,
} from "../../src/utils/llmSuggester";
export * from "../../src/shared/vocabWeights";
export * from "../../src/utils/threadRetrieval";
