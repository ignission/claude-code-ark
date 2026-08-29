import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * worktree の生成・削除は全クライアント共通の事実なので、通知は io.emit で
 * broadcast する（ServerToClientEvents の型コメントにも明記されている）。
 * socket.emit で書くと要求元のタブだけが更新され、他タブのサイドバーに
 * 消えた worktree が残る（session:stop 経路で実際に起きた）。
 *
 * index.ts の socket ハンドラは巨大で単体テストの取り出しができないため、
 * ソース走査で emit の種別だけを固定する。
 */
const source = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf-8"
);

/**
 * `socket.on("<event>", ...)` の登録から次の登録までを切り出す。
 * ハンドラは全て 4 スペース字下げで登録されており、引数を次行に置く
 * 複数行形式（worktree:create）もあるので空白を潰して名前を照合する。
 */
function handlerSource(event: string): string {
  const marker = "\n    socket.on(";
  const starts: number[] = [];
  for (
    let i = source.indexOf(marker);
    i !== -1;
    i = source.indexOf(marker, i + 1)
  ) {
    starts.push(i + 1);
  }
  const index = starts.findIndex(start =>
    source
      .slice(start, start + 200)
      .replace(/\s+/g, "")
      .startsWith(`socket.on("${event}"`)
  );
  if (index === -1) throw new Error(`ハンドラが見つからない: ${event}`);
  return source.slice(starts[index], starts[index + 1] ?? source.length);
}

describe("worktree ライフサイクルイベントの配信範囲", () => {
  for (const event of ["worktree:created", "worktree:deleted"] as const) {
    it(`${event} は io.emit で broadcast する`, () => {
      const emitters = [
        ...source.matchAll(
          new RegExp(String.raw`(\w+)\.emit\("${event}"`, "g")
        ),
      ].map(m => m[1]);

      expect(emitters.length).toBeGreaterThan(0);
      expect(emitters).toEqual(emitters.map(() => "io"));
    });
  }

  // worktree を作成／削除したハンドラが返す worktree:list も全タブへ届ける。
  // repo:select / worktree:list のリクエスト応答は「要求元へのスナップショット」
  // なので socket.emit のままで正しく、ここでは対象にしない。
  for (const event of [
    "worktree:create",
    "worktree:delete",
    "session:stop",
  ] as const) {
    it(`${event} ハンドラの worktree:list は io.emit で broadcast する`, () => {
      const handler = handlerSource(event);

      expect(handler).toContain('io.emit("worktree:list"');
      expect(handler).not.toContain('socket.emit("worktree:list"');
    });
  }
});
