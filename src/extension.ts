import * as vscode from "vscode";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { VirtualDocProvider, DIFF_SCHEME } from "./diff/VirtualDocProvider";
import { log, clearLog } from "./utils/logger";

export function activate(context: vscode.ExtensionContext) {
  clearLog();
  log("INFO", "Claude Luxure activating...");

  const outputChannel = vscode.window.createOutputChannel("Claude Luxure");
  outputChannel.appendLine("Claude Luxure activating...");

  const provider = new ChatViewProvider(context, outputChannel);

  const openChat = async () => {
    await provider.reveal();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-luxure.openChat", openChat)
  );

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBar.command = "claude-luxure.openChat";
  statusBar.text = "$(comment-discussion) Claude Luxure";
  statusBar.tooltip = "Open Claude Luxure chat";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const diffContentProvider = new VirtualDocProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      diffContentProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-luxure.acceptChange", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await provider.getDiffManager().acceptChange(editor.document.uri.fsPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-luxure.rejectChange", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await provider.getDiffManager().rejectChange(editor.document.uri.fsPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-luxure.acceptAllChanges", async () => {
      await provider.getDiffManager().acceptAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-luxure.rejectAllChanges", async () => {
      await provider.getDiffManager().rejectAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-luxure.addToChat", async (uri?: vscode.Uri) => {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let filePath: string;

      if (uri) {
        filePath = uri.fsPath;
      } else if (vscode.window.activeTextEditor) {
        filePath = vscode.window.activeTextEditor.document.uri.fsPath;
      } else {
        return;
      }

      let relativePath = filePath;
      if (workspacePath && filePath.startsWith(workspacePath)) {
        relativePath = filePath.slice(workspacePath.length + 1);
      }

      await openChat();
      provider.addFileToChat(relativePath);
      log("INFO", "addToChat:", relativePath);
    })
  );

  log("INFO", "Claude Luxure activated successfully");
  outputChannel.appendLine("Claude Luxure activated.");
}

export function deactivate() {
  log("INFO", "Claude Luxure deactivated");
}
