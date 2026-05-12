const path = require("node:path");

// プロジェクトルート（リポジトリのルート）。
// data/sessions.db や logs/ は従来通りリポジトリルート基準で保持する。
const projectRoot = path.resolve(__dirname, "..", "..");

// interpreter は PM2_INTERPRETER 環境変数があればその値を使う。
// 本番デプロイでは scripts/deploy.sh が `mise which node` で解決した絶対パスを
// export し、古い /usr/bin/node v18 が PATH 先頭に来た場合の --env-file 起動失敗
// を防ぐ。直接 `pm2 start` する場合 (ローカル動作確認等) はフォールバックで "node"。
//
// 設定ファイル単体で防衛するため、PM2_INTERPRETER が指定されている場合は
// 絶対パスであることを assert する。空文字や相対パスは早期に潰す。
function resolveInterpreter() {
  const raw = process.env.PM2_INTERPRETER;
  if (raw === undefined || raw === "") return "node";
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `PM2_INTERPRETER must be an absolute path, got: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}
const interpreter = resolveInterpreter();

module.exports = {
  apps: [
    {
      name: "claude-code-ark",
      // packages/server/dist/cli.js を実行する。
      // cwd は projectRoot に固定し、data/ などのパス解決を維持する。
      script: path.join(__dirname, "dist", "cli.js"),
      cwd: projectRoot,
      interpreter,
      node_args: "--env-file=.env.production",
      args: "--remote",
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
