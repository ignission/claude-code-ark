import { describe, expect, it } from "vitest";
import { buildVisualizeConversationPrompt } from "./visualize-conversation";

describe("buildVisualizeConversationPrompt", () => {
  it("会話の図解を mermaid コードブロックで要求する", () => {
    const p = buildVisualizeConversationPrompt();
    expect(p).toContain("図解");
    expect(p).toContain("mermaid");
  });

  it("空文字でない", () => {
    expect(buildVisualizeConversationPrompt().length).toBeGreaterThan(0);
  });
});
