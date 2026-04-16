module.exports = {
  apps: [
    {
      name: "claude-code-ark",
      script: "dist/index.js",
      cwd: __dirname,
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
