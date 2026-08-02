/**
 * Browser OAuth open must only hit first-party login hosts.
 * Blocks agent-returned javascript:/http evil hosts via open_external.
 */
export function isAllowedOAuthUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 8_192) return false;
  if ([...trimmed].some((c) => c.charCodeAt(0) < 32)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || host.includes("..")) return false;
  return (
    host === "grok.com" ||
    host.endsWith(".grok.com") ||
    host === "x.ai" ||
    host.endsWith(".x.ai") ||
    host === "accounts.x.ai" ||
    host === "auth.x.ai"
  );
}
