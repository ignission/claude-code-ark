import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KNOWLEDGE_SESSION_START_HOOK_FILENAME =
  "ark-knowledge-session-start-hook.sh";

/**
 * 横断知識の置き場。ark/context 撤去後もパスは変えていない
 * (稼働中のサーバーがあり、rename は移行の失敗経路を増やすだけで機能上の利得が無い)。
 */
export function knowledgeDirectory(): string {
  const base =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "ark", "context", "knowledge");
}

export function failuresPath(): string {
  return path.join(knowledgeDirectory(), "failures.md");
}

export function failuresInboxPath(): string {
  return path.join(knowledgeDirectory(), "failures-inbox.md");
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * SessionStart hook の実体を data dir に生成し、そのパスを返す。
 *
 * 渡すのは知識ファイルへの **ポインタと読む契機** だけで、中身は載せない。
 * #367 の対照実験 (n=6) で効果を観測できたのはこの形であり、
 * task.md 規約・復唱・失敗の自動収集は効果を示せなかったため持たない。
 *
 * failures.md の有無は **hook 実行時** に見る。サーバー起動後に知識が
 * 生まれることがあり、生成時点の判定では取りこぼす。
 */
export function writeKnowledgeSessionStartHookFile(dataDir: string): string {
  const hookPath = path.join(dataDir, KNOWLEDGE_SESSION_START_HOOK_FILENAME);
  const failures = failuresPath();
  const inbox = failuresInboxPath();
  const context = [
    `knowledge/failures.md: ${failures}       ← 作業開始前と、失敗して再試行する前に読む`,
    `failures-inbox.md:     ${inbox}       ← 再発しそうな失敗の候補を書く先`,
  ].join("\n");
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
  // 知識が空なら何も言わない (存在しないファイルを読ませない)。
  const script = [
    "#!/bin/sh",
    `[ -s ${posixShellQuote(failures)} ] || exit 0`,
    `printf '%s\\n' ${posixShellQuote(output)}`,
    "",
  ].join("\n");

  fs.writeFileSync(hookPath, script, { mode: 0o600 });
  // writeFileSync の mode は既存ファイルには適用されないため明示的に矯正する。
  fs.chmodSync(hookPath, 0o600);
  return hookPath;
}

/** settings の command に埋め込むのは hook のパスだけにする。 */
export function knowledgeSessionStartHookCommand(hookPath: string): string {
  return `/bin/sh ${posixShellQuote(hookPath)}`;
}
