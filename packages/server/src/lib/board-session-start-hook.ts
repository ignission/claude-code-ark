import fs from "node:fs";
import path from "node:path";
import { DIAGRAM_DIR } from "@ark/shared";

export const BOARD_SESSION_START_HOOK_FILENAME =
  "ark-board-session-start-hook.sh";

/**
 * Board MCP を使うセッションへ SessionStart hook で渡す説明。
 * ボードは Claude が自由に書いた HTML を見せるだけで、形式や部品の規約は持たない
 * (部品に当てはめさせると、文章を枠に入れただけの図になった)。頼まれていないのに
 * 描かせる文言も置かない。最後の文は分岐TODO。Claude が自分の判断では足さず、
 * ユーザーに頼まれたとき (入力欄の TODO ボタンを含む) だけ足す。
 */
export const BOARD_SESSION_CONTEXT = [
  "This session has a board pane, and board_open opens HTML you wrote in it.",
  "Use it when you want to show something that a picture conveys better than prose, such as a diagram, a screen mockup, or an interactive mock. There is no fixed format and no set of components, so draw freely with HTML / CSS / inline JavaScript to fit what you want to convey.",
  `Write it as a single file at ${DIAGRAM_DIR}/<name>.diagram.html, and put the name to show in the list in <title> (create the parent directory just before writing, only if it does not exist). References to external files, fonts, and images, and network requests, are blocked, so put everything inside the file (images as data URIs or inline SVG). Write links to files in the repository as worktree-relative paths (e.g. src/foo.ts#L10-L24); clicking one opens the file in Ark's file viewer.`,
  'When the user says something like "later" or "put it in the TODOs", add it to this session\'s TODOs with todo_add (after checking the existing ones with todo_list). TODOs are for the human to read later; the human completes and deletes them.',
  "To start a child task that proceeds in another worktree, use task_start instead of creating a git worktree yourself (it starts as an Ark session and sends prompt as the first message. The child appears under its parent in Ark's list, and its result is not returned).",
].join("\n");

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * SessionStart hook の実体を data dir に生成し、そのパスを返す。
 * hook は静的 JSON を stdout へ返すだけで、文言をコマンド引数へ展開しない。
 */
export function writeBoardSessionStartHookFile(dataDir: string): string {
  const hookPath = path.join(dataDir, BOARD_SESSION_START_HOOK_FILENAME);
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: BOARD_SESSION_CONTEXT,
    },
  });
  const script = `#!/bin/sh\nprintf '%s\\n' ${posixShellQuote(output)}\n`;

  fs.writeFileSync(hookPath, script, { mode: 0o600 });
  // writeFileSync の mode は既存ファイルには適用されないため明示的に矯正する。
  fs.chmodSync(hookPath, 0o600);
  return hookPath;
}

/** settings の command に埋め込むのは hook のパスだけにする。 */
export function boardSessionStartHookCommand(hookPath: string): string {
  return `/bin/sh ${posixShellQuote(hookPath)}`;
}
