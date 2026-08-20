// PM2 process config for the production VM (same pattern as mocount).
// .env at /home/azureuser/convoca/.env (mode 600) is loaded by server.js via dotenv.
module.exports = {
  apps: [{
    name: 'convoca',
    script: 'server.js',
    cwd: '/home/azureuser/convoca',
    instances: 1,
    autorestart: true,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
    error_file: '/home/azureuser/convoca/logs/err.log',
    out_file: '/home/azureuser/convoca/logs/out.log',
    time: true,
  }],
};
