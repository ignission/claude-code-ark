#!/usr/bin/env node
/**
 * npm パッケージの入口 (`npx claude-code-ark`)。
 *
 * リポジトリから起動する `cli.ts` との違いは、利用者の機械が何も整っていない前提で動くこと。
 * サーバーを立てる前に次を済ませる。
 *   - Node のバージョンと前提の道具を調べ、足りなければ入れ方を伝えて止まる (`lib/preflight.ts`)
 *   - データの置き場を cwd ではなくホームの下に決める
 *   - Web の静的ファイルを、パッケージの中の配置 (`<pkg>/web`) で指す
 *
 * このファイルが静的に import するのは Node の組み込みに依存するものだけにする。
 * サーバー本体は依存が古い Node で読み込めないことがあり、先に読むと
 * バージョンの案内より前に分かりにくいエラーで落ちる。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultDataDir,
  findOnPath,
  nodeVersionProblem,
  runPreflight,
} from "./lib/preflight.js";
import { resolveClaudePath, resolveTmuxPath } from "./lib/system.js";
import { downloadTtyd } from "./lib/ttyd-download.js";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const USAGE = `Usage: claude-code-ark [options]

Options:
  -r, --remote          Expose Ark through a Cloudflare Named Tunnel
  -q, --quick           Expose Ark through a Cloudflare Quick Tunnel
      --repos <paths>   Comma-separated repositories to allow
      --skip-permissions
                        Start Claude with --dangerously-skip-permissions
  -v, --version         Print the version
  -h, --help            Print this help

Environment:
  PORT                  Port to listen on (default: 4001)
  ARK_DATA_DIR          Where Ark keeps its data
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    const pkg = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf-8")
    );
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const nodeProblem = nodeVersionProblem(process.versions.node);
  if (nodeProblem) fail(nodeProblem);

  process.env.NODE_ENV ??= "production";
  const dataDir =
    process.env.ARK_DATA_DIR || defaultDataDir(process.env, os.homedir());
  process.env.ARK_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });

  const { ttydPath, problems } = await runPreflight({
    platform: process.platform,
    arch: process.arch,
    dataDir,
    ttydOverride: process.env.ARK_TTYD_PATH,
    resolveTmux: resolveTmuxPath,
    resolveClaude: resolveClaudePath,
    findOnPath: name => findOnPath(name, process.env.PATH),
    fileExists: existsSync,
    downloadTtyd,
    log: message => console.log(`[Ark] ${message}`),
  });
  if (problems.length > 0) {
    fail(
      `Ark cannot start yet:\n\n${problems.map(p => `  - ${p}`).join("\n\n")}\n`
    );
  }
  if (ttydPath) process.env.ARK_TTYD_PATH = ttydPath;

  // 文字列リテラルで書くと esbuild がサーバー本体をこのファイルへ束ね、外部の依存の
  // import が先頭に上がって、上の Node の検査より前に読み込まれる。
  const cliMain = "./cli-main.js";
  const { runCli } = (await import(cliMain)) as typeof import("./cli-main.js");
  await runCli({ webStaticDir: path.join(packageDir, "web") });
}

main().catch(error => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
