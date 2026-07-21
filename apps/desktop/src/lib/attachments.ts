import type { PromptAttachment, WorkspaceEntry } from "../bridge/types";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Paste longer than this becomes a text file attachment instead of raw input. */
export const LONG_PASTE_CHARS = 800;
/** Or more than this many lines, even if under the char threshold. */
export const LONG_PASTE_LINES = 20;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "json", "jsonl", "toml", "yaml", "yml", "xml", "csv",
  "tsv", "css", "html", "htm", "js", "jsx", "ts", "tsx", "rs", "py", "go",
  "java", "c", "h", "cpp", "hpp", "sh", "ps1", "sql", "log",
]);

const fileMime = (file: File) => file.type || "application/octet-stream";

const isTextFile = (file: File) => {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension);
};

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read attachment"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Native filesystem path when the host (Tauri/Electron) exposes it on File. */
export function fileSystemPath(file: File): string | undefined {
  const path = (file as File & { path?: string }).path;
  if (typeof path === "string" && path.trim()) return path;
  return undefined;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Prefer a workspace-relative path when the absolute path is inside cwd. */
export function toWorkspaceRelative(absolutePath: string, workspace: string): string {
  const abs = normalizePath(absolutePath);
  const root = normalizePath(workspace).replace(/\/+$/, "");
  if (!root) return abs;
  const rootLower = root.toLowerCase();
  const absLower = abs.toLowerCase();
  if (absLower === rootLower) return ".";
  if (absLower.startsWith(`${rootLower}/`)) {
    return abs.slice(root.length + 1);
  }
  return abs;
}

export function isLongPaste(text: string): boolean {
  if (text.length >= LONG_PASTE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > LONG_PASTE_LINES) return true;
    }
  }
  return false;
}

export function pasteAttachmentName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `paste-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
}

export function preparePasteAttachment(text: string): PromptAttachment {
  const name = pasteAttachmentName();
  const encoder = new TextEncoder();
  return {
    id: crypto.randomUUID(),
    kind: "text",
    name,
    mime: "text/plain",
    size: encoder.encode(text).length,
    text,
  };
}

/** Path-only attachment: shown as a path chip; sent as @mention / resource_link. */
export function preparePathAttachment(
  absoluteOrRelativePath: string,
  workspace: string,
): PromptAttachment {
  const display = toWorkspaceRelative(absoluteOrRelativePath, workspace);
  const name = display.split("/").pop() || display;
  return {
    id: crypto.randomUUID(),
    kind: "path",
    name,
    mime: "text/uri-list",
    size: 0,
    path: display,
  };
}

export async function prepareAttachment(file: File, fallbackName?: string): Promise<PromptAttachment> {
  const name = file.name || fallbackName || `clipboard-${Date.now()}.png`;
  const mime = fileMime(file);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} exceeds 16 MB`);
  if (mime.startsWith("image/")) {
    return { id: crypto.randomUUID(), kind: "image", name, mime, size: file.size, data: await readBase64(file) };
  }
  if (isTextFile(file)) {
    return { id: crypto.randomUUID(), kind: "text", name, mime, size: file.size, text: await file.text() };
  }
  return { id: crypto.randomUUID(), kind: "binary", name, mime, size: file.size, data: await readBase64(file) };
}

/**
 * Prepare a dropped/selected file. When a real filesystem path is available,
 * prefer a path reference (no content upload) so the agent reads from disk.
 */
export async function prepareDroppedFile(
  file: File,
  workspace: string,
  fallbackName?: string,
): Promise<PromptAttachment> {
  const path = fileSystemPath(file);
  if (path) {
    return preparePathAttachment(path, workspace);
  }
  return prepareAttachment(file, fallbackName);
}

export function validateAttachmentSet(items: PromptAttachment[]) {
  if (items.length > MAX_ATTACHMENTS) throw new Error("attachment_count");
  if (items.reduce((total, item) => total + item.size, 0) > MAX_TOTAL_BYTES) {
    throw new Error("attachment_size");
  }
}

/** Active @-mention query just before the cursor, if any. */
export function activeAtQuery(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const head = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const at = head.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0) {
    const prev = head[at - 1];
    // Only trigger after whitespace / start / common openers — not emails mid-token.
    if (prev && !/[\s([{'"`]/.test(prev)) return null;
  }
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

export function insertAtMention(
  text: string,
  start: number,
  end: number,
  path: string,
): { text: string; cursor: number } {
  const mention = `@${path}`;
  const next = `${text.slice(0, start)}${mention} ${text.slice(end)}`;
  return { text: next, cursor: start + mention.length + 1 };
}

export function insertPathToken(
  text: string,
  cursor: number,
  path: string,
): { text: string; cursor: number } {
  const token = `@${path}`;
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
  const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
  const inserted = `${needSpaceBefore ? " " : ""}${token}${needSpaceAfter ? " " : ""}`;
  const next = `${before}${inserted}${after}`;
  const nextCursor = before.length + inserted.length - (needSpaceAfter ? 1 : 0);
  return { text: next, cursor: nextCursor };
}

function scoreFileMatch(path: string, name: string, query: string): number {
  if (!query) return path.split("/").length; // shallow first when empty
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (p.endsWith(`/${q}`) || p === q) return 2;
  if (n.includes(q)) return 3 + (n.indexOf(q) / Math.max(n.length, 1));
  if (p.includes(q)) return 4 + (p.indexOf(q) / Math.max(p.length, 1));
  // Fuzzy: all query chars in order
  let qi = 0;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] === q[qi]) qi += 1;
  }
  if (qi === q.length) return 6;
  return Number.POSITIVE_INFINITY;
}

/** Rank workspace files for the @ picker. */
export function searchWorkspaceFiles(
  entries: WorkspaceEntry[],
  query: string,
  limit = 12,
): WorkspaceEntry[] {
  const files = entries.filter((entry) => !entry.isDir);
  const scored = files
    .map((entry) => ({ entry, score: scoreFileMatch(entry.path, entry.name, query.trim()) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map((item) => item.entry);
}

export function attachmentErrorMessage(code: string, language: string): string {
  if (code === "attachment_count") {
    return language === "zh-CN" ? "每次最多上传 8 个附件" : "Up to 8 attachments per prompt";
  }
  if (code === "attachment_size") {
    return language === "zh-CN" ? "附件总大小不能超过 32 MB" : "Attachments cannot exceed 32 MB in total";
  }
  if (language === "zh-CN") return code.replace(" exceeds 16 MB", " 超过 16 MB");
  return code;
}
