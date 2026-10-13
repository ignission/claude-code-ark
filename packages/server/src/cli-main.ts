/**
 * CLI の本体。argv と環境変数を解釈して `startServer()` に渡し、
 * シグナル (SIGTERM / SIGINT) で戻り値の `stop()` を呼んで終了する。
 *
 * 入口は2つある。どちらも Node のバージョンを確かめてからここを呼ぶ。
 *   - `start.ts`: 前提の道具を調べてから起動する (`scripts/start.sh` / `pnpm start`)
 *   - `cli.ts`: 調べずに起動する (pm2 / `pnpm dev:server`)
 */

import { startServer } from "./index.js";

function parseArgs(): {
  enableRemote: boolean;
  enableQuick: boolean;
  skipPermissions: boolean;
  allowedRepos: string[];
} {
  const args = process.argv.slice(2);
  const enableRemote = args.includes("--remote") || args.includes("-r");
  const enableQuick = args.includes("--quick") || args.includes("-q");
  const skipPermissions =
    args.includes("--skip-permissions") ||
    process.env.SKIP_PERMISSIONS === "true";

  let allowedRepos: string[] = [];
  const reposIndex = args.indexOf("--repos");
  if (reposIndex !== -1 && args[reposIndex + 1]) {
    allowedRepos = args[reposIndex + 1]
      .split(",")
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }

  return { enableRemote, enableQuick, skipPermissions, allowedRepos };
}

export async function runCli(): Promise<void> {
  const { enableRemote, enableQuick, skipPermissions, allowedRepos } =
    parseArgs();
  const publicDomain = process.env.ARK_PUBLIC_DOMAIN;

  const handle = await startServer({
    enableRemote,
    enableQuick,
    skipPermissions,
    publicDomain,
    allowedRepos,
    // webStaticDir 未指定: NODE_ENV=production 時のみ index.ts 側で既定のパスを
    // 自動解決する (`packages/server/dist/index.js` → `../../web/dist`)
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await handle.stop();
    } catch (error) {
      console.error("[Shutdown] error:", error);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
