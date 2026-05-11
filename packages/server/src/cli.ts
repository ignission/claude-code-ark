/**
 * Ark Server CLI エントリーポイント
 *
 * `pnpm dev:server` / `pnpm start` から呼ばれる。argv と環境変数を解釈して
 * `startServer()` に渡す薄いラッパー。シグナル (SIGTERM / SIGINT) を受けて
 * 戻り値の `stop()` を呼び、停止後に `process.exit(0)` する。
 *
 * Electron など埋め込み起動からは `startServer()` を直接 import するため、
 * このファイルは経由しない。
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

async function main(): Promise<void> {
  const { enableRemote, enableQuick, skipPermissions, allowedRepos } =
    parseArgs();
  const publicDomain = process.env.ARK_PUBLIC_DOMAIN;

  const handle = await startServer({
    enableRemote,
    enableQuick,
    skipPermissions,
    publicDomain,
    allowedRepos,
    // webStaticDir 未指定: NODE_ENV=production 時のみ index.ts 側で旧パスを
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

main().catch(error => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
