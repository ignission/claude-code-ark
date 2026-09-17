import { TERMINAL_BG, TERMINAL_FG } from "@ark/shared";

/** ttyd の `-t` オプション (フォントと色)。ttyd の起動時に確定する */
export function buildTtydTerminalOptions(): string[] {
  return [
    "-t",
    "fontSize=14",
    "-t",
    "fontFamily=JetBrains Mono, Menlo, Monaco, monospace",
    "-t",
    `theme=${JSON.stringify({ background: TERMINAL_BG, foreground: TERMINAL_FG })}`,
  ];
}
