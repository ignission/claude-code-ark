/**
 * Electron メインプロセスのバンドル設定。
 *
 * 方針:
 * - Electron 本体は Node のリビルドが必要なため external
 * - @ark/server / @ark/shared は ESM の workspace 依存を bundle に inline する
 *   (Electron がそれぞれを直接解決すると native module の rebuild が複雑に
 *   なるため、main.js に取り込んで Resources 配下を asar に詰める想定)
 * - ただし native module の better-sqlite3 と CLI バイナリ依存の
 *   playwright-core は external のままにし、electron-builder の asarUnpack /
 *   extraResources で素のファイルとして配置する
 * - cloudflared を起動する execa / spawn 系もそのまま (server コード内で
 *   child_process を使う)
 *
 * Phase 2 の最低限の動作確認は `pnpm --filter @ark/desktop dev` (tsx) で行う
 * ため、本ビルドが必須なのは electron-builder で .app を生成する段階のみ。
 */
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const serverPkg = JSON.parse(
  await readFile("../server/package.json", "utf-8")
);
// @ark/server の dependencies は基本 bundle するが、native module や CLI 系は external
const nativeOrCli = new Set([
  "better-sqlite3",
  "playwright-core",
  "@anthropic-ai/claude-agent-sdk",
]);
const serverExternals = Object.keys(serverPkg.dependencies ?? {}).filter(
  name => nativeOrCli.has(name)
);

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  // package.json の "type": "module" + Electron 33+ の ESM 対応に揃える。
  // `import.meta.url` を CJS に変換しなくて済むので main.ts 側の
  // __dirname 解決ロジックがそのまま動く。
  format: "esm",
  platform: "node",
  target: "node20",
  external: [
    // Electron 本体は bundle 不可
    "electron",
    // native / CLI 依存 (asarUnpack 想定)
    ...serverExternals,
    // Node 標準モジュール代替の有無を esbuild に判断させない
    "fsevents",
  ],
  // ESM 出力に CJS の `require` shim を埋め込む。
  // bundle 対象の依存 (electron-log 等) が内部で `require("electron")` を
  // 呼ぶ場合、esbuild が生成する `__require2` shim では dynamic require が
  // サポートされず "Dynamic require of \"electron\" is not supported" で
  // 起動時に throw する。`createRequire(import.meta.url)` で本物の CJS
  // require を再生して電子モジュール解決を担保する。
  banner: {
    js: "import { createRequire as __arkCreateRequire } from 'node:module';const require = __arkCreateRequire(import.meta.url);",
  },
});

// F8: preload script を別エントリで bundle する。
// Electron は preload を CJS (require) で読み込むため、main.js (ESM) とは
// format を分ける必要がある。contextIsolation=true で renderer に inject される。
await build({
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["electron"],
});
