import { describe, it, expect } from "vitest";
import {
  collectToolImages,
  extractGeneratedMediaPaths,
  extractImageContent,
  isMediaGenToolCall,
} from "./toolMedia";

describe("extractImageContent / collectToolImages", () => {
  it("extracts base64 image blocks", () => {
    const ref = extractImageContent({
      type: "image",
      mimeType: "image/png",
      data: "AAAA",
    });
    expect(ref).toEqual({
      media: "image",
      kind: "data",
      mimeType: "image/png",
      data: "AAAA",
    });
  });
  it("collects images from tool content array", () => {
    const out = collectToolImages({
      content: [
        { type: "content", content: { type: "image", mimeType: "image/jpeg", data: "BB" } },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("data");
  });
});

describe("isMediaGenToolCall", () => {
  it("matches imagine / image_gen titles and variants", () => {
    expect(isMediaGenToolCall({ title: "imagine: cat" })).toBe(true);
    expect(isMediaGenToolCall({ title: "image_gen — cat" })).toBe(true);
    expect(isMediaGenToolCall({ title: "read_file", rawInput: { path: "a" } })).toBe(false);
    expect(
      isMediaGenToolCall({ title: "tool", rawInput: { variant: "ImageGen" } }),
    ).toBe(true);
  });
});

describe("extractGeneratedMediaPaths", () => {
  it("parses JSON path blocks", () => {
    const out = extractGeneratedMediaPaths({
      content: [{ type: "text", text: JSON.stringify({ path: "C:\\\\Users\\\\x\\\\out.png" }) }],
    });
    expect(
      out.some((m) => m.kind === "path" && "path" in m && m.path.includes("out.png")),
    ).toBe(true);
  });
  it("scrapes Windows paths from prose", () => {
    const out = extractGeneratedMediaPaths({
      content: [
        {
          type: "text",
          text: "Saved to \\\\?\\C:\\Users\\Harry\\AppData\\Local\\Temp\\frame.mp4 done",
        },
      ],
    });
    expect(
      out.some((m) => m.media === "video" && m.kind === "path" && "path" in m && m.path.includes("frame.mp4")),
    ).toBe(true);
  });
});
