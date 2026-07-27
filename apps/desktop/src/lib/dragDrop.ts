/**
 * Desktop file drag/drop helpers.
 *
 * Tauri 2 exposes real filesystem paths via webview drag-drop events.
 * In the browser (Vite-only / Electron without path injection) we fall back
 * to HTML5 File objects and optional `File.path` / text URI lists.
 */

export type DragDropPhase = "enter" | "over" | "leave" | "drop";

export interface DragDropPathsEvent {
  phase: DragDropPhase;
  /** Absolute filesystem paths when the host provides them. */
  paths: string[];
  position?: { x: number; y: number };
}

type Unlisten = () => void;

/** True while a native Tauri drag-drop listener is active (skip HTML5 file drops). */
let nativeListenerCount = 0;

export function isNativeDragDropActive(): boolean {
  return nativeListenerCount > 0;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Hit-test a client point against an element (used to route native drops). */
export function elementContainsPoint(
  el: Element | null | undefined,
  position?: { x: number; y: number } | null,
): boolean {
  if (!el || !position) return false;
  const rect = el.getBoundingClientRect();
  return (
    position.x >= rect.left &&
    position.x <= rect.right &&
    position.y >= rect.top &&
    position.y <= rect.bottom
  );
}

/**
 * Parse absolute paths from HTML5 drag data (text/uri-list / plain text).
 * Used when Tauri is not available or File.path is empty.
 */
export function parseDroppedPathList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      if (line.startsWith("file://")) {
        try {
          const url = new URL(line);
          return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
        } catch {
          return line.replace(/^file:\/\//, "");
        }
      }
      return line;
    })
    .filter(Boolean);
}

/** Collect filesystem paths from an HTML5 DataTransfer (File.path + uri-list). */
export function pathsFromDataTransfer(data: DataTransfer | null | undefined): string[] {
  if (!data) return [];
  const fromFiles: string[] = [];
  for (const file of Array.from(data.files ?? [])) {
    const path = (file as File & { path?: string }).path;
    if (typeof path === "string" && path.trim()) fromFiles.push(path.trim());
  }
  if (fromFiles.length > 0) return uniquePaths(fromFiles);

  const uriList = data.getData("text/uri-list") || data.getData("text/plain");
  if (uriList.trim()) return uniquePaths(parseDroppedPathList(uriList));
  return [];
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * Subscribe to native path-aware drag/drop when running under Tauri.
 * Returns null outside Tauri so callers can keep HTML5 handlers.
 */
export async function listenNativeFileDrop(
  onEvent: (event: DragDropPathsEvent) => void,
): Promise<Unlisten | null> {
  if (!isTauri()) return null;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    nativeListenerCount += 1;
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        onEvent({ phase: "enter", paths: payload.paths, position: payload.position });
      } else if (payload.type === "over") {
        onEvent({ phase: "over", paths: [], position: payload.position });
      } else if (payload.type === "leave") {
        onEvent({ phase: "leave", paths: [] });
      } else if (payload.type === "drop") {
        onEvent({
          phase: "drop",
          paths: payload.paths,
          position: payload.position,
        });
      }
    });
    return () => {
      nativeListenerCount = Math.max(0, nativeListenerCount - 1);
      unlisten();
    };
  } catch {
    return null;
  }
}
