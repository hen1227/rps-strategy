module.exports = {
  apps: [
    {
      name: 'rps-strategy-api',
      script: './bin/rps-server',
      cwd: __dirname,
      env: {
        PORT: '8080',
        RPS_DATABASE_PATH: 'data/rps-strategy.sqlite',
      },
      autorestart: true,
      max_memory_restart: '300M',
    },
  ],
};
