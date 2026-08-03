/* Disk-backed UI transcript cache for fast mission switching.
   Full ACP session/load can take many seconds on large histories; we paint
   the last known UI snapshot immediately, then refresh in the background. */

import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionBlock } from "../bridge/types";

/** Keep cache JSON small enough to parse quickly (last N blocks). */
const MAX_CACHED_BLOCKS = 160;

function freezeBlock(block: SessionBlock): SessionBlock {
  if (block.type === "assistant") return { ...block, streaming: false };
  if (block.type === "thinking") return { ...block, live: false };
  if (block.type === "tool") {
    const raw = String(block.call?.status ?? "done");
    const status =
      raw === "running" || raw === "pending" || raw === "in_progress"
        ? ("done" as const)
        : raw === "cancelled" || raw === "error" || raw === "awaiting_permission"
          ? (raw as "cancelled" | "error" | "awaiting_permission")
          : ("done" as const);
    return {
      ...block,
      call: {
        ...block.call,
        status,
        title: block.call?.title || block.call?.rawKind || "tool",
      },
    };
  }
  return block;
}

function compactSession(session: Session): Session {
  const source =
    session.blocks.length <= MAX_CACHED_BLOCKS
      ? session.blocks
      : session.blocks.slice(-MAX_CACHED_BLOCKS);
  return {
    ...session,
    status: "idle",
    blocks: source.map(freezeBlock),
  };
}

function isSessionShape(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const s = value as Session;
  return (
    typeof s.id === "string" &&
    typeof s.cwd === "string" &&
    Array.isArray(s.blocks) &&
    typeof s.status === "string"
  );
}

export async function loadSessionCache(id: string): Promise<Session | null> {
  try {
    const raw = await invoke<string | null>("read_session_cache", { id });
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSessionShape(parsed) || parsed.id !== id) return null;
    return {
      ...parsed,
      status: "idle",
      blocks: parsed.blocks.map(freezeBlock),
    };
  } catch {
    return null;
  }
}

const writeTimers = new Map<string, number>();

/** Cancel a pending cache write (call before deleteSession). */
export function cancelSaveSessionCache(id: string): void {
  const existing = writeTimers.get(id);
  if (existing !== undefined) {
    window.clearTimeout(existing);
    writeTimers.delete(id);
  }
}

/** Debounced write so streaming turns do not thrash disk. */
export function scheduleSaveSessionCache(session: Session): void {
  if (!session.id || session.blocks.length === 0) return;
  const existing = writeTimers.get(session.id);
  if (existing !== undefined) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    writeTimers.delete(session.id);
    void saveSessionCache(session);
  }, 800);
  writeTimers.set(session.id, timer);
}

export async function saveSessionCache(session: Session): Promise<void> {
  if (!session.id || session.blocks.length === 0) return;
  try {
    const payload = JSON.stringify(compactSession(session));
    await invoke("write_session_cache", { id: session.id, content: payload });
  } catch {
    // Cache is best-effort; never block the UI on disk errors.
  }
}
