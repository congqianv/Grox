/* ─────────────────────────────────────────────────────────────────────────
   IME-safe keyboard helpers.

   Chinese / Japanese / Korean input methods use Enter to confirm a candidate.
   That keydown must not trigger "send". Relying only on `event.isComposing`
   is insufficient on some WebViews (notably macOS WKWebView): the Enter that
   commits composition often arrives after `compositionend`, with
   isComposing already false.
   ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useRef } from "react";

type KeyLike = {
  key: string;
  nativeEvent: { isComposing?: boolean };
  keyCode: number;
  /** Modifier keys — Ctrl/Meta+Enter (interject) must not be swallowed after IME commit. */
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * Tracks composition state and suppresses the post-commit Enter.
 * Attach the returned handlers to the same textarea as onKeyDown.
 */
export function useImeGuard() {
  const composing = useRef(false);
  const justEnded = useRef(false);
  const clearTimer = useRef<number | null>(null);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
    justEnded.current = false;
    if (clearTimer.current !== null) {
      window.clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
  }, []);

  const onCompositionEnd = useCallback(() => {
    composing.current = false;
    // Block the next Enter that some IMEs fire immediately after end.
    justEnded.current = true;
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => {
      justEnded.current = false;
      clearTimer.current = null;
    }, 100);
  }, []);

  /** True when custom key handlers (send, slash/at pickers) must stand down. */
  const isImeBlocking = useCallback((event: KeyLike) => {
    if (event.nativeEvent.isComposing === true || event.keyCode === 229 || composing.current) {
      return true;
    }
    // Only swallow the spurious bare post-commit Enter (IME confirm).
    // Ctrl/Meta+Enter (插话) and Shift+Enter (newline) must still work.
    if (
      justEnded.current &&
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      justEnded.current = false;
      if (clearTimer.current !== null) {
        window.clearTimeout(clearTimer.current);
        clearTimer.current = null;
      }
      return true;
    }
    return false;
  }, []);

  return { onCompositionStart, onCompositionEnd, isImeBlocking };
}
