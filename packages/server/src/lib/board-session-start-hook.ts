import fs from "node:fs";
import path from "node:path";
import { DIAGRAM_DIR } from "@ark/shared";

export const BOARD_SESSION_START_HOOK_FILENAME =
  "ark-board-session-start-hook.sh";

/**
 * Board MCP を使うセッションへ SessionStart hook で渡す説明。
 * 移設前の 5 文は変えず、1 文ずつ改行して読みやすくする。
 */
export const BOARD_SESSION_CONTEXT = [
  "このセッションにはボードペインがあり、図と文書を表示できる。board_open（ボードに開く）、board_comments（人間が付けたコメントを読む）、board_authoring_guide（作図・文書規約を読む）、board_reply（コメントへ返信する）の 4 つのツールを持っている。",
  `ユーザーが「図解して」「図で説明して」「フロー図/構成図にして」等、図解・作図・可視化を求めたら、チャットに mermaid や ASCII 図を出すのではなく、${DIAGRAM_DIR}/ 配下に *.diagram.html を書き、board_open で開くこと。`,
  '設計メモ・仕様・調査結果など「人に読ませる文書」も同じ形式で書ける。model の type を "doc" にすると、ユーザーが本文をテキスト選択してコメントを付けられる、レビュー可能な文書になる。',
  "ユーザーが「コメントした」「図を見て」等と言ったら、board_comments で未解決コメントを読み、引用された箇所を直してから board_open で開き直し、board_reply で対応内容を返信すること。",
  "書き込む直前に parent directory が存在しない場合だけ作成する。.diagram.html を書く前に必ず board_authoring_guide で規約を取得し、その内容に従う。",
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
