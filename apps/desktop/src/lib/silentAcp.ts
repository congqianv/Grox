/** History-flood shapes dropped during silent agent-bind (mirrors Rust filter). */
export function isSilentHistoryFloodLine(line: string): boolean {
  return (
    line.includes("sessionUpdate") ||
    line.includes("agent_thought_chunk") ||
    line.includes('"session/update"') ||
    line.includes("x.ai/session/update")
  );
}

/** Best-effort session id from an ACP JSON line. */
export function sessionIdFromAcpLine(line: string): string | null {
  try {
    const value = JSON.parse(line) as {
      sessionId?: string;
      params?: { sessionId?: string };
    };
    const sid = value.params?.sessionId ?? value.sessionId;
    return typeof sid === "string" && sid.length > 0 ? sid : null;
  } catch {
    return null;
  }
}

/**
 * JS belt-and-braces: drop only when the line is a history flood AND belongs
 * to a session currently silent-binding (or single-session legacy case).
 */
export function shouldDropSilentInbound(
  line: string,
  silentSessionIds: ReadonlySet<string>,
): boolean {
  if (silentSessionIds.size === 0) return false;
  if (!isSilentHistoryFloodLine(line)) return false;
  const sid = sessionIdFromAcpLine(line);
  if (sid) return silentSessionIds.has(sid);
  // No session id: drop only under single-flight silent bind.
  return silentSessionIds.size === 1;
}
