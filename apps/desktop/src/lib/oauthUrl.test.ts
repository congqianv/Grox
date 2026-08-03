import { describe, expect, it } from "vitest";
import { isAllowedOAuthUrl } from "./oauthUrl";

describe("isAllowedOAuthUrl", () => {
  it("accepts first-party https login hosts", () => {
    expect(isAllowedOAuthUrl("https://accounts.x.ai/oauth/start")).toBe(true);
    expect(isAllowedOAuthUrl("https://auth.x.ai/login")).toBe(true);
    expect(isAllowedOAuthUrl("https://grok.com/auth")).toBe(true);
    expect(isAllowedOAuthUrl("https://www.grok.com/auth")).toBe(true);
  });

  it("rejects non-https and foreign hosts", () => {
    expect(isAllowedOAuthUrl("http://accounts.x.ai/oauth")).toBe(false);
    expect(isAllowedOAuthUrl("https://evil.com/?x=1")).toBe(false);
    expect(isAllowedOAuthUrl("https://x.ai.evil.com/phish")).toBe(false);
    expect(isAllowedOAuthUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedOAuthUrl("https://user:pass@x.ai/")).toBe(false);
    expect(isAllowedOAuthUrl("")).toBe(false);
  });
});
