import type { ClipboardEvent, DragEvent } from "react";

/** Shared attachment rules for the composer and the message-edit box. */
export const MAX_IMAGES = 10;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// External drops travel through postMessage as base64 — cap them so a stray
// video doesn't stall the webview bridge.
export const MAX_DROP_FILE_MB = 25;
export const MAX_DROP_FILE_BYTES = MAX_DROP_FILE_MB * 1024 * 1024;

/** Image files carried by a paste (screenshots, images copied from apps). */
export function imageFilesFromClipboard(e: ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.items ?? [])
    .filter((item) => ACCEPTED_IMAGE_TYPES.includes(item.type))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
}

export function toRelativePath(absPath: string, workspacePath?: string): string {
  if (!workspacePath) return absPath;
  const normalized = absPath.replace(/\\/g, "/");
  const normalizedWs = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith(normalizedWs + "/")) {
    return normalized.slice(normalizedWs.length + 1);
  }
  return absPath;
}

/** file://-decoded, workspace-relative paths from a uri/path list. */
export function pathsFromUriList(raw: string, workspacePath?: string): string[] {
  return raw
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p))
    .map((p) => toRelativePath(p, workspacePath));
}

/** How many child names we send the host to fingerprint a dropped folder. */
export const MAX_FOLDER_MANIFEST_ENTRIES = 200;

/** A folder dropped from outside VS Code, as the webview can see it: no path,
 * just a name and a listing. The host turns that back into a real path. */
export interface DroppedFolder {
  name: string;
  entries: string[];
  /** The listing hit the cap above, so it is a prefix of the real one. */
  truncated: boolean;
}

export interface DropPayload {
  /** Real paths (VS Code explorer / editor tabs, file:// uris) — mention directly. */
  pathList: string;
  /** Image blobs — attach as thumbnails. */
  images: File[];
  /** Non-image blobs within the size cap — the host writes temp copies. */
  sendable: File[];
  oversizeCount: number;
  /** Dropped directories — the host resolves each to a real path. */
  folders: FileSystemDirectoryEntry[];
  /** Dragged plain text (a path from a terminal, etc.) — last resort. */
  text: string;
}

/** `@mention` for a path, or a plain backticked path when it contains
 * whitespace — the mention syntax stops at the first space. */
export function pathMentionSnippet(filePath: string): string {
  return /\s/.test(filePath) ? `\`${filePath}\`` : `@${filePath}`;
}

/** Classify a drop into the buckets the composer and edit box both handle.
 * Must be called synchronously in the drop handler — the dataTransfer goes
 * inert afterwards. OS drops (Finder, browsers) carry blobs with no path. */
export function classifyDrop(e: DragEvent): DropPayload {
  const codeUriList = e.dataTransfer.getData("application/vnd.code.uri-list");
  const fileUris = e.dataTransfer
    .getData("text/uri-list")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("file://"))
    .join("\n");
  const pathList = (codeUriList || fileUris).trim();

  // Collect dropped blobs; directories come out as entry handles instead
  // (FileReader can't ingest them, and they carry no path).
  const items = Array.from(e.dataTransfer.items ?? []).filter(
    (it) => it.kind === "file"
  );
  let droppedFiles: File[] = [];
  const folders: FileSystemDirectoryEntry[] = [];
  if (items.length > 0) {
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        folders.push(entry as FileSystemDirectoryEntry);
        continue;
      }
      const f = it.getAsFile();
      if (f) droppedFiles.push(f);
    }
  } else {
    droppedFiles = Array.from(e.dataTransfer.files);
  }

  const images = droppedFiles.filter((f) =>
    ACCEPTED_IMAGE_TYPES.includes(f.type)
  );
  const others = droppedFiles.filter(
    (f) => !ACCEPTED_IMAGE_TYPES.includes(f.type)
  );
  const sendable = others.filter((f) => f.size <= MAX_DROP_FILE_BYTES);

  return {
    pathList,
    images,
    sendable,
    oversizeCount: others.length - sendable.length,
    folders,
    text: pathList ? "" : e.dataTransfer.getData("text/plain").trim(),
  };
}

/** Read a dropped directory's immediate child names — the fingerprint the host
 * uses to tell two same-named folders apart. Entry handles stay valid after
 * the drop event, so this can run async. */
export async function readFolderManifest(
  dir: FileSystemDirectoryEntry
): Promise<DroppedFolder> {
  const reader = dir.createReader();
  const entries: string[] = [];
  let truncated = false;
  // readEntries answers in chunks and signals the end with an empty batch.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(
        (found) => resolve(found),
        () => resolve([])
      );
    });
    if (batch.length === 0) break;
    for (const entry of batch) {
      if (entries.length >= MAX_FOLDER_MANIFEST_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(entry.name);
    }
    if (truncated) break;
  }
  return { name: dir.name, entries, truncated };
}

export function readFolderManifests(
  dirs: FileSystemDirectoryEntry[]
): Promise<DroppedFolder[]> {
  return Promise.all(dirs.map(readFolderManifest));
}

/** Absolute-looking paths carried by a drop's plain text — some sources (a
 * terminal, some file managers) hand over the real path there, which saves the
 * host a filesystem search. */
export function dropPathHints(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .map((line) =>
      line.startsWith("file://") ? decodeURIComponent(line.slice(7)) : line
    )
    .filter((line) => line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line));
}

/** Base64 payloads (data-url prefix stripped) for saveDroppedFiles. */
export function filesToBase64(
  files: File[]
): Promise<{ name: string; dataBase64: string }[]> {
  return Promise.all(
    files.map(
      (f) =>
        new Promise<{ name: string; dataBase64: string } | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve({
              name: f.name,
              dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
            });
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(f);
        })
    )
  ).then((results) =>
    results.filter(
      (r): r is { name: string; dataBase64: string } => r !== null
    )
  );
}
