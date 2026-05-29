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
        postMessage: (msg: unknown) => console.log("[dev] postMessage:", msg),
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
