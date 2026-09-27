import { describe, expect, it } from "vitest";
import { buildVisualizeConversationPrompt } from "./visualize-conversation";

describe("buildVisualizeConversationPrompt", () => {
  it("会話の要点を自由な説明図にしてボードに開くよう頼む", () => {
    const p = buildVisualizeConversationPrompt();
    expect(p).toContain("図");
    expect(p).toContain("board_open");
    expect(p).toContain("説明図（自由形）");
  });

  it("ボードが使えないセッションでは mermaid に落とす", () => {
    // board MCP を持たない (再起動前の) セッションでも何かは返せるようにする
    expect(buildVisualizeConversationPrompt()).toContain("mermaid");
  });
});
