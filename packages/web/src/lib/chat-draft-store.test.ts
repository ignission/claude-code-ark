import { describe, expect, it, vi } from "vitest";
import {
  requestChatDraft,
  subscribeChatDraft,
  takeChatDraft,
} from "./chat-draft-store";

describe("chat-draft-store", () => {
  it("置いた下書きを1回だけ受け取れる", () => {
    requestChatDraft("/wt/a", "本文");
    expect(takeChatDraft("/wt/a")).toBe("本文");
    expect(takeChatDraft("/wt/a")).toBeNull();
  });

  it("別のworktreeの下書きは受け取れない", () => {
    requestChatDraft("/wt/a", "本文");
    expect(takeChatDraft("/wt/b")).toBeNull();
    expect(takeChatDraft("/wt/a")).toBe("本文");
  });

  it("同じworktreeに2回置くと後のもので置き換える", () => {
    requestChatDraft("/wt/a", "1回目");
    requestChatDraft("/wt/a", "2回目");
    expect(takeChatDraft("/wt/a")).toBe("2回目");
  });

  it("置くたびに購読者へ通知し、解除後は通知しない", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatDraft(listener);
    requestChatDraft("/wt/c", "x");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    requestChatDraft("/wt/c", "y");
    expect(listener).toHaveBeenCalledTimes(1);
    takeChatDraft("/wt/c");
  });
});
