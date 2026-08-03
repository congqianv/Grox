import { describe, it, expect } from "vitest";
import { GROX_PLAN_PRIMER, isPrimerText, PRIMER_MARKER } from "./planPrimer";

describe("isPrimerText", () => {
  it("matches grox and legacy markers", () => {
    expect(isPrimerText(GROX_PLAN_PRIMER)).toBe(true);
    expect(isPrimerText(`${PRIMER_MARKER}\nmore`)).toBe(true);
    expect(isPrimerText("[vscode-supergrok primer v5]\nok")).toBe(true);
    expect(isPrimerText("normal user message")).toBe(false);
  });
});
