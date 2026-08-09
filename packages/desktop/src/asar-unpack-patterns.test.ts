/**
 * electron-builder の asarUnpack pattern が、実際の依存レイアウトを拾うかを固定する。
 *
 * ここが外れると `.app` は無言で壊れる:
 * - 同梱 claude は asar 内パスから spawn できない (ENOTDIR)。main.ts の bootstrap は
 *   `app.asar.unpacked` 配下の存在を起動時に fail-fast で要求するので、unpack 漏れ =
 *   アプリが起動しない
 * - native module (better-sqlite3) も asar 内では読めない
 *
 * 罠は `.pnpm` がドット始まりであること。minimatch の `**` は既定でドット始まりの
 * セグメントに一致しないため、`**\/node_modules/<pkg>/**` だけでは pnpm の isolated
 * レイアウトを拾えない。v1.4.0 のリリースはこれに起因して失敗した。
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(HERE, "../electron-builder.yml");

/**
 * matcher は electron-builder（app-builder-lib）が解決するものと同一実装を使う。
 * 自前に依存させた minimatch で検証すると、builder 側がバージョンや実装を
 * 変えたときにテストだけが通る状態になる。
 *
 * pnpm の strict なレイアウトでは「直接依存を1つずつ辿る」必要があるため、
 * electron-builder（desktop の devDependency）→ app-builder-lib → minimatch と
 * 段階的に解決する。途中が変わったら resolve が失敗して気づける。
 */
const require = createRequire(import.meta.url);
const builderRequire = createRequire(
  require.resolve("electron-builder/package.json")
);
const appBuilderLibRequire = createRequire(
  builderRequire.resolve("app-builder-lib/package.json")
);
const { minimatch } = appBuilderLibRequire("minimatch") as {
  minimatch: (target: string, pattern: string) => boolean;
};

/** electron-builder.yml の asarUnpack 配列を読む（YAML 依存を足さない簡易 parse） */
function readAsarUnpackPatterns(): string[] {
  const lines = fs.readFileSync(CONFIG_PATH, "utf-8").split("\n");
  const start = lines.findIndex(line => line.trim() === "asarUnpack:");
  if (start === -1) throw new Error("asarUnpack が見つかりません");
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const matched = line.match(/^\s+-\s+"(.+)"\s*$/);
    if (!matched) break;
    patterns.push(matched[1] as string);
  }
  return patterns;
}

/** 配布物で unpack されていないと壊れるパス（flat / pnpm isolated の両レイアウト） */
const MUST_UNPACK = [
  // 同梱 claude（main.ts の bootstrap が起動時に要求する）
  "node_modules/@anthropic-ai/claude-code-darwin-arm64/claude",
  "node_modules/.pnpm/@anthropic-ai+claude-code-darwin-arm64@2.1.226/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude",
  "node_modules/@anthropic-ai/claude-code/cli.js",
  "node_modules/.pnpm/@anthropic-ai+claude-code@2.1.226/node_modules/@anthropic-ai/claude-code/cli.js",
  // native module
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  // Chromium 起動経路で fs アクセスをするため asar 内では動かない
  "node_modules/playwright-core/cli.js",
  "node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/cli.js",
];

describe("asarUnpack pattern", () => {
  const patterns = readAsarUnpackPatterns();

  it.each(MUST_UNPACK)("unpack 対象に含める: %s", target => {
    expect(patterns.some(pattern => minimatch(target, pattern))).toBe(true);
  });

  it("無関係な依存まで unpack しない", () => {
    const untouched = [
      "node_modules/react/index.js",
      "node_modules/.pnpm/react@19.2.8/node_modules/react/index.js",
    ];
    for (const target of untouched) {
      expect(patterns.some(pattern => minimatch(target, pattern))).toBe(false);
    }
  });
});
