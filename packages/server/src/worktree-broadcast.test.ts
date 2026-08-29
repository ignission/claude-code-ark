import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * worktree:created / worktree:deleted は「worktree が生まれた／消えた」という
 * 全クライアント共通の事実で、ServerToClientEvents の型コメントでも io.emit で
 * broadcast する契約になっている。socket.emit で書くと要求元のタブだけが更新され、
 * 他タブのサイドバーに消えた worktree が残る（session:stop 経路で実際に起きた）。
 *
 * index.ts の socket ハンドラは巨大で単体テストの取り出しができないため、
 * ソース走査で emit の種別だけを固定する。
 */
const source = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf-8"
);

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
});
