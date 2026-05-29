import * as fs from "fs";
import * as path from "path";

export class SnapshotManager {
  private snapshots = new Map<string, string>();

  capture(filePath: string): void {
    if (this.snapshots.has(filePath)) {
      return;
    }
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        this.snapshots.set(filePath, content);
      } else {
        this.snapshots.set(filePath, "");
      }
    } catch {
      this.snapshots.set(filePath, "");
    }
  }

  getOriginal(filePath: string): string | undefined {
    return this.snapshots.get(filePath);
  }

  has(filePath: string): boolean {
    return this.snapshots.has(filePath);
  }

  clear(filePath: string): void {
    this.snapshots.delete(filePath);
  }

  clearAll(): void {
    this.snapshots.clear();
  }

  revert(filePath: string): boolean {
    const original = this.snapshots.get(filePath);
    if (original === undefined) {
      return false;
    }

    try {
      if (original === "") {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } else {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, original, "utf-8");
      }
      this.snapshots.delete(filePath);
      return true;
    } catch {
      return false;
    }
  }

  revertAll(): number {
    let count = 0;
    for (const filePath of Array.from(this.snapshots.keys())) {
      if (this.revert(filePath)) {
        count++;
      }
    }
    return count;
  }

  getAllPaths(): string[] {
    return Array.from(this.snapshots.keys());
  }
}
