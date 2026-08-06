interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

class VsCodeWrapper {
  private readonly api: VsCodeApi;

  constructor() {
    if (typeof acquireVsCodeApi === "function") {
      this.api = acquireVsCodeApi();
    } else {
      this.api = {
        postMessage: (msg: unknown) => {
          console.log("[dev] postMessage:", msg);
          // Harness-only loopback: answer suggestPhrase with a canned "magie"
          // completion after a realistic delay, so the blue row is demoable
          // without an extension host (the real model runs there).
          const m = msg as {
            type?: string;
            draft?: string;
            examples?: string[];
            kind?: "continue" | "expand";
          };
          if (m?.type === "suggestPhrase" && typeof m.draft === "string") {
            const draft = m.draft.trim();
            const kind = m.kind ?? "continue";
            const canned =
              kind === "expand"
                ? `can you ${draft.replace(/\s+/g, " ")} and show me a screenshot as proof?`
                : draft.toLowerCase().startsWith("add")
                  ? `${draft} yellow idle counter pill on the tab strip`
                  : `${draft} in the composer and explain how it works`;
            const suggestions =
              kind === "expand"
                ? [canned]
                : [
                    canned,
                    `${draft} and run the battle suite`,
                    `${draft} then screenshot it as proof`,
                  ];
            setTimeout(
              () => {
                window.postMessage(
                  {
                    type: "phraseSuggestion",
                    draft: m.draft,
                    suggestion: canned,
                    suggestions,
                    examples: m.examples ?? [],
                    kind,
                  },
                  "*"
                );
              },
              kind === "expand" ? 340 : 220
            );
          }
        },
        getState: () => undefined,
        setState: () => {},
      };
    }
  }

  postMessage(message: unknown) {
    this.api.postMessage(message);
  }

  getState() {
    return this.api.getState();
  }

  setState(state: unknown) {
    this.api.setState(state);
  }
}

const vscode = new VsCodeWrapper();
export default vscode;
