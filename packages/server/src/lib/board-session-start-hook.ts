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
 * ユーザーの明示の頼みか、Stop hook の判定 (block の理由) に頼まれたときだけ足す。
 */
export const BOARD_SESSION_CONTEXT = [
  "このセッションにはボードペインがあり、board_open で自分が書いた HTML をそこに開ける。",
  "図、画面のイメージ、触れるモックなど、文章より絵のほうが伝わるものを見せたいときに使う。決まった形式や部品は無いので、HTML / CSS / インラインの JavaScript で、伝えたいことに合わせて自由に描く。",
  `ファイルは ${DIAGRAM_DIR}/<名前>.diagram.html に 1 ファイルで書き、<title> に一覧へ出す名前を付ける (書き込む直前に parent directory が無い場合だけ作る)。外部のファイル・フォント・画像への参照と通信は遮断されるので、すべてファイルの中に書く (画像は data URI か inline SVG)。リポジトリのファイルへのリンクは worktree 相対のパス (例: src/foo.ts#L10-L24) で書くと、押したときに Ark のファイルビューアで開く。`,
  "ユーザーに「あとで」「TODO に入れて」と言われたとき、または Ark の分岐TODOの判定に頼まれたときは、todo_add でこのセッションの TODO に足す (todo_list で既存を確かめてから)。TODO は人間が後で読むためのもので、完了と削除は人間が行う。",
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
