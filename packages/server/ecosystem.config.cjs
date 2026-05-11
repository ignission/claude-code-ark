const path = require("node:path");

// プロジェクトルート（リポジトリのルート）。
// data/sessions.db や logs/ は従来通りリポジトリルート基準で保持する。
const projectRoot = path.resolve(__dirname, "..", "..");

module.exports = {
  apps: [
    {
      name: "claude-code-ark",
      // packages/server/dist/index.js を実行する。
      // cwd は projectRoot に固定し、data/ などのパス解決を維持する。
      script: path.join(__dirname, "dist", "index.js"),
      cwd: projectRoot,
      interpreter: "node",
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
