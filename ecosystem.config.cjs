module.exports = {
  apps: [
    {
      name: 'campus-vend',
      cwd: __dirname,
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
      },
    },
  ],
};
