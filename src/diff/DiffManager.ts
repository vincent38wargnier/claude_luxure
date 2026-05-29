import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SnapshotManager } from "./SnapshotManager";
import { DIFF_SCHEME } from "./VirtualDocProvider";
import { createPatch } from "diff";

export interface PendingDiff {
  filePath: string;
  diff: string;
}

export class DiffManager {
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private onDiffDetected: ((diff: PendingDiff) => void) | undefined;
  private openDiffTabs = new Set<string>();

  constructor(private snapshotManager: SnapshotManager) {}

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
  }
}
