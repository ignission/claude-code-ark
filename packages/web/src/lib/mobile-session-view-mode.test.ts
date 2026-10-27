import { describe, expect, it } from "vitest";
import {
  createChatViewRequest,
  shouldShowChatForRequest,
} from "./mobile-session-view-mode";

describe("会話モードへ切り替える要求", () => {
  it("作るたびに通し番号を進める", () => {
    const first = createChatViewRequest(null, "s1");
    expect(first).toEqual({ sessionId: "s1", sequence: 1 });
    expect(createChatViewRequest(first, "s2")).toEqual({
      sessionId: "s2",
      sequence: 2,
    });
  });

  it("自分のセッション宛てで、まだ処理していない番号のときだけ切り替える", () => {
    const request = { sessionId: "s1", sequence: 3 };
    expect(shouldShowChatForRequest("s1", request, null)).toBe(true);
    expect(shouldShowChatForRequest("s1", request, 3)).toBe(false);
    expect(shouldShowChatForRequest("s2", request, null)).toBe(false);
    expect(shouldShowChatForRequest("s1", null, null)).toBe(false);
  });
});
