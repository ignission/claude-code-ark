/**
 * CLI の本体。argv と環境変数を解釈して `startServer()` に渡し、
 * シグナル (SIGTERM / SIGINT) で戻り値の `stop()` を呼んで終了する。
 *
 * 入口は2つある。どちらも Node のバージョンを確かめてからここを呼ぶ。
 *   - `cli.ts`: リポジトリから起動する (`pnpm start` / pm2)
 *   - `bin.ts`: npm パッケージから起動する (`npx claude-code-ark`)
 */

import { startServer } from "./index.js";

export interface RunCliOverrides {
  /**
   * Web の静的ファイルの場所。npm パッケージは配置がリポジトリと違うので
   * `bin.ts` が明示する。未指定なら `index.ts` が NODE_ENV=production のときだけ
   * リポジトリの配置 (`../../web/dist`) で解決する。
   */
  webStaticDir?: string;
}

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

export async function runCli(overrides: RunCliOverrides = {}): Promise<void> {
  const { enableRemote, enableQuick, skipPermissions, allowedRepos } =
    parseArgs();
  const publicDomain = process.env.ARK_PUBLIC_DOMAIN;

  const handle = await startServer({
    enableRemote,
    enableQuick,
    skipPermissions,
    publicDomain,
    allowedRepos,
    webStaticDir: overrides.webStaticDir,
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
