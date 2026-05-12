const path = require("node:path");

// プロジェクトルート（リポジトリのルート）。
// data/sessions.db や logs/ は従来通りリポジトリルート基準で保持する。
const projectRoot = path.resolve(__dirname, "..", "..");

// interpreter は PM2_INTERPRETER 環境変数があればその絶対パスを使う。
// scripts/deploy.sh が `mise which node` で解決して export する。
// 古い /usr/bin/node v18 が PATH 先頭に来た場合の --env-file 起動失敗を防ぐ。
const interpreter = process.env.PM2_INTERPRETER || "node";

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
