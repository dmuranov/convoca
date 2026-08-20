# Deploy Convoca to the shared Azure VM (co-hosted with testpilot:3001 and mocount:3002).
# NEVER run box-wide pm2 commands (pm2 kill / delete all) — mocount lives on this box too.
$ErrorActionPreference = "Stop"
$KEY = "C:\Users\danij\testpilot\Azure key\testpilot-vm_key.pem"
$VM = "azureuser@51.145.161.85"
$DEST = "/home/azureuser/convoca"

Write-Host "== sync sources =="
ssh -i $KEY $VM "mkdir -p $DEST/logs"
# db/ carries schema.sql but never the sqlite files (.gitignore'd locally anyway)
scp -i $KEY -r `
  package.json package-lock.json server.js ecosystem.config.cjs `
  src db/schema.sql data scripts web `
  "${VM}:$DEST/" | Out-Null
ssh -i $KEY $VM "mkdir -p $DEST/db && mv -f $DEST/schema.sql $DEST/db/schema.sql"

Write-Host "== install deps =="
ssh -i $KEY $VM "cd $DEST && npm ci --omit=dev 2>&1 | tail -2"

Write-Host "== seed (idempotent; needs baseline files under ~/grants/baseline_out) =="
ssh -i $KEY $VM "cd $DEST && BASELINE_JSON=/home/azureuser/grants/baseline_out/concesiones_palencia_raw_3y.json node scripts/seed.js"

Write-Host "== (re)start pm2 app 'convoca' ONLY =="
ssh -i $KEY $VM "cd $DEST && (pm2 restart convoca --update-env 2>/dev/null || pm2 start ecosystem.config.cjs) && pm2 save && pm2 status convoca"

Write-Host "== health =="
ssh -i $KEY $VM "curl -s http://localhost:3003/health"
