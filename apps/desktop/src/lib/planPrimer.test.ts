import { describe, it, expect } from "vitest";
import {
  formatPlanVerdictMessage,
  GROX_PLAN_PRIMER,
  isPlanVerdictText,
  isPrimerText,
  PRIMER_MARKER,
} from "./planPrimer";

describe("isPrimerText", () => {
  it("matches grox and legacy markers", () => {
    expect(isPrimerText(GROX_PLAN_PRIMER)).toBe(true);
    expect(isPrimerText(`${PRIMER_MARKER}\nmore`)).toBe(true);
    expect(isPrimerText("[vscode-supergrok primer v5]\nok")).toBe(true);
    expect(isPrimerText("normal user message")).toBe(false);
  });
});

describe("plan verdict markers", () => {
  it("detects and formats verdict lines", () => {
    expect(isPlanVerdictText("[Plan approved]")).toBe(true);
    expect(isPlanVerdictText("[Plan rejected]\nfix X")).toBe(true);
    expect(isPlanVerdictText("not a verdict")).toBe(false);
    expect(formatPlanVerdictMessage("rejected", "fix X")).toBe(
      "[Plan rejected]\nfix X",
    );
  });
});
