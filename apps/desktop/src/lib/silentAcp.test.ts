import { describe, expect, it } from "vitest";
import {
  isSilentHistoryFloodLine,
  sessionIdFromAcpLine,
  shouldDropSilentInbound,
} from "./silentAcp";

describe("session-scoped silent ACP filter", () => {
  const floodA =
    '{"method":"session/update","params":{"sessionId":"sess-a","update":{"sessionUpdate":"agent_message_chunk"}}}';
  const floodB =
    '{"method":"session/update","params":{"sessionId":"sess-b","update":{"sessionUpdate":"agent_message_chunk"}}}';
  const rpcOk = '{"jsonrpc":"2.0","id":1,"result":{}}';

  it("detects history flood lines", () => {
    expect(isSilentHistoryFloodLine(floodA)).toBe(true);
    expect(isSilentHistoryFloodLine(rpcOk)).toBe(false);
  });

  it("extracts sessionId from params", () => {
    expect(sessionIdFromAcpLine(floodA)).toBe("sess-a");
    expect(sessionIdFromAcpLine(rpcOk)).toBe(null);
  });

  it("does not drop other sessions while sess-a is silent", () => {
    const silent = new Set(["sess-a"]);
    expect(shouldDropSilentInbound(floodA, silent)).toBe(true);
    expect(shouldDropSilentInbound(floodB, silent)).toBe(false);
    expect(shouldDropSilentInbound(rpcOk, silent)).toBe(false);
  });

  it("keeps other sessions when multiple silent sets are active", () => {
    const silent = new Set(["sess-a", "sess-c"]);
    expect(shouldDropSilentInbound(floodA, silent)).toBe(true);
    expect(shouldDropSilentInbound(floodB, silent)).toBe(false);
  });
});
