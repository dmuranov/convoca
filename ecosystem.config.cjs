// PM2 process config for the production VM (same pattern as mocount).
// .env at /home/azureuser/convoca/.env (mode 600) is loaded by server.js via dotenv.
module.exports = {
  apps: [{
    name: 'convoca',
    script: 'server.js',
    cwd: '/home/azureuser/convoca',
    instances: 1,
    autorestart: true,
    // 500M was too tight for the PLACSP poll's pliego PDF parsing (pdf-parse holding large
    // buffers across a sequential, throttled walk) - it tripped mid-poll two mornings
    // running (2026-09-01, 2026-09-02), stranding whatever the walk hadn't reached yet
    // every single day. VM has 3.8G total, ~2.6G available with every other app on the
    // box already running; convoca's own baseline is under 100M. Raised with headroom,
    // not tuned to the exact peak - if this is still hit, that's real unbounded growth
    // worth its own investigation, not evidence the number needs nudging up again.
    max_memory_restart: '1536M',
    env: { NODE_ENV: 'production' },
    error_file: '/home/azureuser/convoca/logs/err.log',
    out_file: '/home/azureuser/convoca/logs/out.log',
    time: true,
  }],
};
