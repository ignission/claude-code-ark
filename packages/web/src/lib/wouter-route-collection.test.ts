/**
 * wouter のローカルパッチ撤去を守る回帰テスト。
 *
 * 初期 bootstrap には wouter@3.7.1 へのパッチが同梱されており、`Switch` 配下の
 * ルート一覧を `window.__WOUTER_ROUTES__` へ収集していた。この global を読む
 * コードはアプリにもツールにも存在しなかった一方、パッチが 3.7.1 に固定されて
 * いるため wouter の更新を塞いでいた。そこでパッチごと撤去した。
 *
 * このテストは「撤去の前提（参照が無いこと）」を固定する。もし将来この global を
 * 読むコードが入ったら、パッチはもう無いので実行時に undefined を掴んで無言で
 * 壊れる。その前にここで気づけるようにする。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const REMOVED_GLOBAL = "__WOUTER_ROUTES__";

function collectSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, found);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

describe("wouter パッチの撤去", () => {
  it("削除した global を読むコードが残っていない", () => {
    const sources = collectSourceFiles(PACKAGES_DIR).filter(
      file => !file.endsWith("wouter-route-collection.test.ts")
    );
    expect(sources.length).toBeGreaterThan(50); // 走査対象を取り違えていない

    const offenders = sources.filter(file =>
      fs.readFileSync(file, "utf-8").includes(REMOVED_GLOBAL)
    );

    expect(offenders).toEqual([]);
  });
});
