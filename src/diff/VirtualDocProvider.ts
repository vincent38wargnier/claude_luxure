import * as vscode from "vscode";

export const DIFF_SCHEME = "claude-luxure-diff";

export class VirtualDocProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return Buffer.from(uri.query, "base64").toString("utf-8");
  }
}
