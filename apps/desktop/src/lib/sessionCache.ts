/* Disk-backed UI transcript cache for fast mission switching.
   Full ACP session/load can take many seconds on large histories; we paint
   the last known UI snapshot immediately, then refresh in the background. */

import { invoke } from "@tauri-apps/api/core";
import type { PromptAttachmentSummary, Session, SessionBlock } from "../bridge/types";

/** Keep cache JSON small enough to parse quickly (last N blocks). */
const MAX_CACHED_BLOCKS = 160;
/** Cap tool output / terminal text in cache (chars). */
const MAX_CACHED_TOOL_TEXT = 8_000;
/** Cap assistant/thinking text in cache (chars) — full text returns via offline scan. */
const MAX_CACHED_BODY_TEXT = 24_000;

function stripAttachmentPayloads(
  attachments: PromptAttachmentSummary[] | undefined,
): PromptAttachmentSummary[] | undefined {
  if (!attachments?.length) return attachments;
  return attachments.map((a) => {
    // Drop base64 image bytes — reopen uses offline history / re-attach for thumbs.
    if (a.kind === "image" && a.data) {
      const { data: _drop, ...rest } = a;
      return { ...rest, name: a.name || "image" };
    }
    return a;
  });
}

function truncateText(value: string | undefined, limit: number): string | undefined {
  if (value == null) return value;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[cache truncated ${value.length.toLocaleString()} chars]`;
}

function freezeBlock(block: SessionBlock): SessionBlock {
  if (block.type === "assistant") {
    return {
      ...block,
      streaming: false,
      text: truncateText(block.text, MAX_CACHED_BODY_TEXT) ?? "",
    };
  }
  if (block.type === "thinking") {
    return {
      ...block,
      live: false,
      text: truncateText(block.text, MAX_CACHED_BODY_TEXT) ?? "",
    };
  }
  if (block.type === "user") {
    return {
      ...block,
      attachments: stripAttachmentPayloads(block.attachments),
      text: truncateText(block.text, MAX_CACHED_BODY_TEXT) ?? "",
    };
  }
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
        input: truncateText(block.call?.input, MAX_CACHED_TOOL_TEXT),
        output: truncateText(block.call?.output, MAX_CACHED_TOOL_TEXT),
        // Drop embedded screenshots from cache; cap terminal line dump.
        images: undefined,
        terminal: block.call?.terminal
          ? {
              ...block.call.terminal,
              lines: (block.call.terminal.lines ?? []).slice(-80).map((line) =>
                line.length > 500 ? `${line.slice(0, 500)}…` : line,
              ),
            }
          : undefined,
      },
    };
  }
  if (block.type === "system") {
    return {
      ...block,
      text: truncateText(block.text, MAX_CACHED_TOOL_TEXT) ?? "",
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
