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
