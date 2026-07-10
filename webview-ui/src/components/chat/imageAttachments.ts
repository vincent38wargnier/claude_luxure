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

export interface DropPayload {
  /** Real paths (VS Code explorer / editor tabs, file:// uris) — mention directly. */
  pathList: string;
  /** Image blobs — attach as thumbnails. */
  images: File[];
  /** Non-image blobs within the size cap — the host writes temp copies. */
  sendable: File[];
  oversizeCount: number;
  folderCount: number;
  /** Dragged plain text (a path from a terminal, etc.) — last resort. */
  text: string;
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

  // Collect dropped blobs, skipping folders (FileReader can't ingest them).
  const items = Array.from(e.dataTransfer.items ?? []).filter(
    (it) => it.kind === "file"
  );
  let droppedFiles: File[] = [];
  let folderCount = 0;
  if (items.length > 0) {
    for (const it of items) {
      if (it.webkitGetAsEntry?.()?.isDirectory) {
        folderCount++;
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
    folderCount,
    text: pathList ? "" : e.dataTransfer.getData("text/plain").trim(),
  };
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
