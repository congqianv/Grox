/**
 * Mirrors Rust `is_safe_preview_dev_script` for dual-gate documentation/tests.
 * Workspace package.json "dev" values must match known frontend tooling and
 * must not contain shell chaining or downloaders.
 */
export function isSafePreviewDevScript(script: string): boolean {
  const s = script.trim().toLowerCase();
  if (!s) return false;
  if (
    s.includes("|") ||
    s.includes("&") ||
    s.includes(";") ||
    s.includes("`") ||
    s.includes("$") ||
    s.includes("\n") ||
    s.includes("\r") ||
    s.includes("curl ") ||
    s.includes("wget ") ||
    s.includes("powershell") ||
    s.includes("cmd.exe") ||
    s.includes("rm ") ||
    s.includes("del ")
  ) {
    return false;
  }
  const markers = [
    "vite",
    "next",
    "nuxt",
    "astro",
    "react-scripts",
    "webpack",
    "webpack-dev-server",
    "vue-cli-service",
    "ng serve",
    "parcel",
    "remix",
    "solid-start",
    "svelte-kit",
    "qwik",
    "rsbuild",
    "farm",
  ];
  return markers.some((m) => s.includes(m)) || s === "dev" || s.startsWith("dev ");
}
