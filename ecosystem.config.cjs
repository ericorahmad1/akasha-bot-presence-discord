// pm2 start ecosystem.config.cjs   — runs beside meeting-bot, does not touch it.
module.exports = {
  apps: [
    {
      name: 'Akashapresence-bot',
      script: 'src/index.js',
      cwd: __dirname,
      node_args: '--disable-warning=ExperimentalWarning',
      env: { TZ: 'Asia/Makassar', NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: '200M',
      time: true,
    },
  ],
};
