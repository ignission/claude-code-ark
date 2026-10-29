import { describe, expect, it } from "vitest";
import { buildChatQuickActionMessage } from "./chat-quick-actions";

describe("buildChatQuickActionMessage", () => {
  it("入力欄が空なら、直前の会話を対象にする", () => {
    expect(buildChatQuickActionMessage("diagram", "  ")).toBe(
      "直前の説明をボードに図解して。"
    );
    expect(buildChatQuickActionMessage("todo", "")).toBe(
      "この会話で保留にした話題をTODOに残して。"
    );
  });

  it("入力欄の文があれば、それを対象として前に置く", () => {
    expect(buildChatQuickActionMessage("diagram", " 認証の流れ ")).toBe(
      "認証の流れ\n\nこれをボードに図解して。"
    );
    expect(buildChatQuickActionMessage("todo", "ログの形式")).toBe(
      "ログの形式\n\nこれをTODOに残して。"
    );
  });
});
