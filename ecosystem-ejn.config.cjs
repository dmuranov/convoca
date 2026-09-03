// PM2 process config for FondBiH on the shared Azure VM - same pattern as
// ecosystem.config.cjs (convoca), a separate app entirely (build brief §0: "Do not touch
// the other apps on the box"). .env at /home/azureuser/fondbih/.env (mode 600) is loaded
// by serverEjn.js via dotenv.
module.exports = {
  apps: [{
    name: 'fondbih',
    script: 'serverEjn.js',
    cwd: '/home/azureuser/fondbih',
    instances: 1,
    autorestart: true,
    // Starting point, not a measured peak (no production traffic yet) - convoca's own
    // 500M->1536M bump only happened after a real, characterized memory driver (pliego
    // PDF parsing) showed up in production. Revisit with a real number if this trips,
    // not preemptively.
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production' },
    error_file: '/home/azureuser/fondbih/logs/err.log',
    out_file: '/home/azureuser/fondbih/logs/out.log',
    time: true,
  }],
};
