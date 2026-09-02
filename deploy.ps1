# Deploy Convoca to the shared Azure VM (co-hosted with testpilot:3001 and mocount:3002).
# NEVER run box-wide pm2 commands (pm2 kill / delete all) — mocount lives on this box too.
$ErrorActionPreference = "Stop"
$KEY = "C:\Users\danij\.ssh\testpilot_vm"
$VM = "azureuser@51.145.161.85"
$DEST = "/home/azureuser/convoca"

$SHA = (git rev-parse HEAD).Trim()
if (git status --porcelain) {
  Write-Host "!! working tree has uncommitted changes - deploying HEAD ($SHA), not what's on disk"
}

Write-Host "== sync sources =="
ssh -i $KEY $VM "mkdir -p $DEST/logs"
# db/ carries schema.sql but never the sqlite files (.gitignore'd locally anyway)
scp -i $KEY -r `
  package.json package-lock.json server.js ecosystem.config.cjs `
  src db/schema.sql data scripts web `
  "${VM}:$DEST/" | Out-Null
ssh -i $KEY $VM "mkdir -p $DEST/db && mv -f $DEST/schema.sql $DEST/db/schema.sql && echo $SHA > $DEST/DEPLOYED_SHA"

Write-Host "== install deps =="
ssh -i $KEY $VM "cd $DEST && npm ci --omit=dev 2>&1 | tail -2"

Write-Host "== seed (idempotent; needs baseline files under ~/grants/baseline_out) =="
ssh -i $KEY $VM "cd $DEST && BASELINE_JSON=/home/azureuser/grants/baseline_out/concesiones_palencia_raw_3y.json node scripts/seed.js"

Write-Host "== (re)start pm2 app 'convoca' ONLY =="
# `pm2 restart convoca` (by name) restarts the process but does NOT re-read
# ecosystem.config.cjs - a config-only change (max_memory_restart, env, etc.) would
# silently keep running under the old settings forever. `pm2 restart <file>` reloads the
# file's config for the matching app by name; falls back to `start` only on a truly first
# deploy where the app isn't registered with pm2 yet.
ssh -i $KEY $VM "cd $DEST && (pm2 restart ecosystem.config.cjs --update-env 2>/dev/null || pm2 start ecosystem.config.cjs) && pm2 save && pm2 status convoca"

Write-Host "== health =="
$health = ssh -i $KEY $VM "curl -s http://localhost:3003/health"
Write-Host $health
$liveSha = ($health | ConvertFrom-Json).sha
if ($liveSha -ne $SHA) {
  Write-Host "!! DEPLOY NOT VERIFIED: /health reports sha $liveSha, expected $SHA"
  Write-Host "!! the running process is not serving the commit that was just pushed - do not report this as deployed"
  exit 1
}
Write-Host "== verified: production is serving $SHA =="
