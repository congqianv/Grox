/**
 * Lightweight operator locale for store/bridge notices (not full i18n).
 * Preferences store is the source of truth; localStorage is the fallback when
 * called outside React (store actions, bridge).
 */

export function isZhLocale(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("grox.language") !== "en-US";
    }
  } catch {
    /* private mode */
  }
  return true;
}

/** Pick zh or en operator-facing string from current locale. */
export function tOp(zh: string, en: string): string {
  return isZhLocale() ? zh : en;
}
