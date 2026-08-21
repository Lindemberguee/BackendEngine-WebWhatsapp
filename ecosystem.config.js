module.exports = {
  apps: [
    {
      name: 'webwhatsapp-backend',
      cwd: __dirname + '/Backend',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '512M',
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      out_file: '/var/log/pm2/webwhatsapp-backend-out.log',
      error_file: '/var/log/pm2/webwhatsapp-backend-error.log',
      time: true,
      merge_logs: true,
    },
  ],
};
