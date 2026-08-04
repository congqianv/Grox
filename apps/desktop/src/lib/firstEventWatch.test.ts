import { describe, expect, it } from "vitest";
import { isZeroEventLiveTurn } from "./firstEventWatch";

describe("isZeroEventLiveTurn", () => {
  it("detects running turn with only the primary user bubble", () => {
    expect(
      isZeroEventLiveTurn(
        [
          { type: "assistant" },
          { type: "user", interjected: false },
        ],
        "running",
      ),
    ).toBe(true);
  });

  it("is false once any model event exists after the user bubble", () => {
    expect(
      isZeroEventLiveTurn(
        [
          { type: "user" },
          { type: "thinking" },
        ],
        "running",
      ),
    ).toBe(false);
    expect(
      isZeroEventLiveTurn(
        [
          { type: "user" },
          { type: "tool" },
        ],
        "running",
      ),
    ).toBe(false);
  });

  it("ignores interjections when finding the primary user", () => {
    expect(
      isZeroEventLiveTurn(
        [
          { type: "user" },
          { type: "user", interjected: true },
        ],
        "running",
      ),
    ).toBe(true);
  });

  it("is false when idle or when a gate card is up", () => {
    expect(isZeroEventLiveTurn([{ type: "user" }], "idle")).toBe(false);
    expect(isZeroEventLiveTurn([{ type: "user" }], "awaiting_permission")).toBe(false);
  });
});
