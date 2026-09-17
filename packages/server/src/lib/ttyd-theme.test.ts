import { TERMINAL_BG, TERMINAL_FG } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { buildTtydTerminalOptions } from "./ttyd-theme.js";

describe("buildTtydTerminalOptions", () => {
  it("暖色の暗い背景と文字色を ttyd に渡す", () => {
    const args = buildTtydTerminalOptions();
    expect(TERMINAL_BG).toBe("#1c1a17");
    expect(TERMINAL_FG).toBe("#e6e1da");
    const themeIndex = args.findIndex(a => a.startsWith("theme="));
    expect(args[themeIndex - 1]).toBe("-t");
    expect(JSON.parse(args[themeIndex].slice("theme=".length))).toEqual({
      background: TERMINAL_BG,
      foreground: TERMINAL_FG,
    });
  });

  it("フォントの指定は今のまま", () => {
    expect(buildTtydTerminalOptions()).toEqual([
      "-t",
      "fontSize=14",
      "-t",
      "fontFamily=JetBrains Mono, Menlo, Monaco, monospace",
      "-t",
      `theme={"background":"${TERMINAL_BG}","foreground":"${TERMINAL_FG}"}`,
    ]);
  });
});
