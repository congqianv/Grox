/** Detect whether the draft looks like it contains markdown markup. */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  return (
    /(\*\*[^*\n]+\*\*|__[^_\n]+__)/.test(text) ||
    /(^|\s)(\*[^*\n]+\*|_[^_\n]+_)(\s|$|[.,;:!?])/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /^#{1,6}\s/m.test(text) ||
    /^```/m.test(text) ||
    /^\s*[-*+]\s+\S/m.test(text) ||
    /^\s*\d+\.\s+\S/m.test(text) ||
    /\[[^\]]+]\([^)]+\)/.test(text) ||
    /^>\s/m.test(text) ||
    /~~[^~\n]+~~/.test(text)
  );
}
