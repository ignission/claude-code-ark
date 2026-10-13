/**
 * Ark Server CLI エントリーポイント
 *
 * `pnpm dev:server` / `pnpm start` から呼ばれる。Node のバージョンを確かめて
 * `cli-main.ts` の `runCli()` を呼ぶ。npm パッケージからの起動は `bin.ts` が入口。
 *
 * Electron など埋め込み起動からは `startServer()` を直接 import するため、
 * このファイルは経由しない。
 */

// Node バージョンガード（直接実行時の補助）。
//
// 本番 pm2 経路では `node_args: "--env-file=.env.production"` が付くため、
// 20.6 未満の Node は本ファイルに到達する前に `bad option: --env-file` で
// 死ぬ。そちらの主防衛線は scripts/deploy.sh の resolve_node_interpreter
// (絶対パス + バージョン検証 → PM2_INTERPRETER) で担保している。
//
// このガードは deploy.sh をバイパスして `node packages/server/dist/cli.js`
// を直接実行した場合や、systemd の PATH が予期せず古い node を引いた場合に
// 「アプリの最低 Node 要件」を import 前に明示する第二防衛線。
{
  const required = { major: 20, minor: 6 };
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (
    major < required.major ||
    (major === required.major && minor < required.minor)
  ) {
    process.stderr.write(
      `Ark requires Node.js >= ${required.major}.${required.minor} ` +
        `but got ${process.versions.node} at ${process.execPath}\n`
    );
    process.exit(1);
  }
}

import { runCli } from "./cli-main.js";

runCli().catch(error => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
