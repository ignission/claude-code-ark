module.exports = {
  apps: [
    {
      name: 'claude-code-manager',
      script: 'dist/index.js',
      cwd: __dirname,
      node_args: '--env-file=.env.production',
      args: '--remote',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
