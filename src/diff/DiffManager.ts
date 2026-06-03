import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SnapshotManager } from "./SnapshotManager";
import { DIFF_SCHEME } from "./VirtualDocProvider";
import { createPatch, diffLines } from "diff";

export interface PendingDiff {
  filePath: string;
  diff: string;
}

export class DiffManager {
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private onDiffDetected: ((diff: PendingDiff) => void) | undefined;
  private openDiffTabs = new Set<string>();

  // Inline diff: highlight the lines Claude changed directly in the real file
  // (Cursor-style), rather than only showing a separate side-by-side diff.
  private addedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(63, 185, 80, 0.14)",
    overviewRulerColor: "rgba(63, 185, 80, 0.7)",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private decorationListeners: vscode.Disposable[] = [];

  // Quick-diff: feed VS Code our snapshot as the file's "original" so it renders
  // native gutter change bars + an expandable inline diff (red removals + green
  // additions, per-hunk revert) right in the real file — against our own
  // baseline, so it also works for untracked/new files where git HEAD is empty.
  private readonly sourceControl: vscode.SourceControl;

  constructor(private snapshotManager: SnapshotManager) {
    // Keep highlights in sync as files open, become visible, or change.
    this.decorationListeners.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.refreshInlineDiff(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.visibleTextEditors.find(
          (ed) => ed.document === e.document
        );
        if (editor) {
          this.refreshInlineDiff(editor);
        }
      })
    );

    this.sourceControl = vscode.scm.createSourceControl(
      "claudeLuxure",
      "Claude Luxure"
    );
    this.sourceControl.inputBox.visible = false; // no commit box; we only want quick-diff
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => {
        const original = this.snapshotManager.getOriginal(uri.fsPath);
        if (original === undefined) {
          return undefined; // no pending Claude change → no quick-diff
        }
        // Serve the snapshot through our content provider (base64 in the query).
        return uri.with({
          scheme: DIFF_SCHEME,
          query: Buffer.from(original, "utf-8").toString("base64"),
        });
      },
    };
  }

  setDiffCallback(cb: (diff: PendingDiff) => void) {
    this.onDiffDetected = cb;
  }

  startWatching(workspacePath: string): void {
    this.stopWatching();

    const pattern = new vscode.RelativePattern(workspacePath, "**/*");
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      pattern,
      false,
      false,
      false
    );

    const handleChange = (uri: vscode.Uri) => {
      if (!this.snapshotManager.has(uri.fsPath)) {
        return;
      }
      this.computeAndEmitDiff(uri.fsPath);
    };

    this.fileWatcher.onDidChange(handleChange);
    this.fileWatcher.onDidCreate(handleChange);
  }

  stopWatching(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
  }

  captureFile(filePath: string): void {
    this.snapshotManager.capture(filePath);
  }

  private computeAndEmitDiff(filePath: string): void {
    const original = this.snapshotManager.getOriginal(filePath);
    if (original === undefined) {
      return;
    }

    let current: string;
    try {
      current = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    if (original === current) {
      return;
    }

    const fileName = path.basename(filePath);
    const patch = createPatch(fileName, original, current, "original", "modified");

    if (this.onDiffDetected) {
      this.onDiffDetected({ filePath, diff: patch });
    }
    // Update inline highlights live if the file is already open.
    this.refreshVisibleInlineDiffs(filePath);
  }

  async openDiffEditor(filePath: string): Promise<void> {
    const original = this.snapshotManager.getOriginal(filePath);
    if (original === undefined) {
      return;
    }

    const fileName = path.basename(filePath);
    const uri = vscode.Uri.file(filePath);

    const originalUri = vscode.Uri.parse(
      `${DIFF_SCHEME}:${fileName}`
    ).with({
      query: Buffer.from(original).toString("base64"),
    });

    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      uri,
      `${fileName}: Claude's Changes`,
      { preserveFocus: true }
    );

    this.openDiffTabs.add(filePath);
  }

  /**
   * Open the real file and highlight the lines Claude changed inline (Cursor
   * style). Works for any file — tracked, untracked, new, or already accepted —
   * because it compares against our own snapshot, never git HEAD.
   */
  async revealFile(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    this.refreshInlineDiff(editor);
  }

  /** Re-highlight the changed lines in `editor` from the snapshot, or clear the
   * highlight when the file has no pending Claude changes. */
  private refreshInlineDiff(editor: vscode.TextEditor): void {
    const original = this.snapshotManager.getOriginal(editor.document.uri.fsPath);
    if (original === undefined) {
      editor.setDecorations(this.addedLineDecoration, []);
      return;
    }
    const current = editor.document.getText();
    const ranges: vscode.Range[] = [];
    const lastLine = Math.max(0, editor.document.lineCount - 1);
    let line = 0;
    for (const part of diffLines(original, current)) {
      const count = part.count ?? 0;
      if (part.added) {
        for (let i = 0; i < count && line + i <= lastLine; i++) {
          ranges.push(new vscode.Range(line + i, 0, line + i, 0));
        }
        line += count;
      } else if (!part.removed) {
        line += count;
      }
    }
    editor.setDecorations(this.addedLineDecoration, ranges);
  }

  /** Re-highlight every visible editor showing `filePath`. */
  private refreshVisibleInlineDiffs(filePath: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === filePath) {
        this.refreshInlineDiff(editor);
      }
    }
  }

  async closeDiffEditor(filePath: string): Promise<void> {
    this.openDiffTabs.delete(filePath);

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const modified = tab.input.modified;
          if (modified.fsPath === filePath) {
            await vscode.window.tabGroups.close(tab);
            return;
          }
        }
      }
    }
  }

  async acceptChange(filePath: string): Promise<void> {
    await this.closeDiffEditor(filePath);
    this.snapshotManager.clear(filePath);
    this.refreshVisibleInlineDiffs(filePath);
  }

  async rejectChange(filePath: string): Promise<void> {
    this.snapshotManager.revert(filePath);
    await this.closeDiffEditor(filePath);

    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === filePath
    );
    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      const original = this.snapshotManager.getOriginal(filePath);
      if (original !== undefined) {
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        edit.replace(doc.uri, fullRange, original);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
      }
    }
    this.refreshVisibleInlineDiffs(filePath);
  }

  async acceptAll(): Promise<void> {
    const paths = this.snapshotManager.getAllPaths();
    for (const p of paths) {
      await this.acceptChange(p);
    }
  }

  async rejectAll(): Promise<void> {
    const paths = this.snapshotManager.getAllPaths();
    for (const p of paths) {
      await this.rejectChange(p);
    }
  }

  getPendingDiffs(): PendingDiff[] {
    const diffs: PendingDiff[] = [];
    for (const filePath of this.snapshotManager.getAllPaths()) {
      const original = this.snapshotManager.getOriginal(filePath);
      if (original === undefined) {
        continue;
      }
      try {
        const current = fs.readFileSync(filePath, "utf-8");
        if (original !== current) {
          const fileName = path.basename(filePath);
          const patch = createPatch(fileName, original, current, "original", "modified");
          diffs.push({ filePath, diff: patch });
        }
      } catch {
        continue;
      }
    }
    return diffs;
  }

  dispose(): void {
    this.stopWatching();
    this.openDiffTabs.clear();
    this.addedLineDecoration.dispose();
    this.decorationListeners.forEach((d) => d.dispose());
    this.decorationListeners = [];
    this.sourceControl.dispose();
  }
}
