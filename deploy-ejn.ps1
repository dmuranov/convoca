# Deploy FondBiH to the shared Azure VM (co-hosted with testpilot:3001, mocount:3002,
# convoca:3003, budgety:3004). NEVER run box-wide pm2 commands (pm2 kill / delete all) -
# every other app on this box would go down too.
$ErrorActionPreference = "Stop"
$KEY = "C:\Users\danij\.ssh\testpilot_vm"
$VM = "azureuser@51.145.161.85"
$DEST = "/home/azureuser/fondbih"

$SHA = (git rev-parse HEAD).Trim()
if (git status --porcelain) {
  Write-Host "!! working tree has uncommitted changes - deploying HEAD ($SHA), not what's on disk"
}

Write-Host "== sync sources =="
ssh -i $KEY $VM "mkdir -p $DEST/logs $DEST/db"
scp -i $KEY -r `
  package.json package-lock.json serverEjn.js ecosystem-ejn.config.cjs `
  src db/schema-ejn.sql `
  scripts/pullMunicipality.js scripts/buildMunicipalityPage.js scripts/testTerminationCards.js `
  "${VM}:$DEST/" | Out-Null
ssh -i $KEY $VM "mv -f $DEST/schema-ejn.sql $DEST/db/schema-ejn.sql && mkdir -p $DEST/scripts && mv -f $DEST/pullMunicipality.js $DEST/buildMunicipalityPage.js $DEST/testTerminationCards.js $DEST/scripts/ && echo $SHA > $DEST/DEPLOYED_SHA"

Write-Host "== one-time seed: already-verified Prijedor/Zenica data (first deploy only - harmless no-op after) =="
# Never overwrite a live DB that's since moved past this snapshot via the general sync -
# only seeds an empty/missing db, matching convoca's seed.js being idempotent by design.
$remoteDbExists = ssh -i $KEY $VM "test -f $DEST/db/fondbih.sqlite && echo yes || echo no"
if ($remoteDbExists.Trim() -eq "no") {
  Write-Host "   (no existing remote DB found - seeding from local db/fondbih.sqlite)"
  scp -i $KEY db/fondbih.sqlite "${VM}:$DEST/db/fondbih.sqlite" | Out-Null
} else {
  Write-Host "   (remote DB already exists - leaving it alone, not overwriting live data)"
}

Write-Host "== ANTHROPIC_API_KEY (reused from convoca's own .env, never printed) =="
ssh -i $KEY $VM "if [ ! -f $DEST/.env ] || ! grep -q ANTHROPIC_API_KEY $DEST/.env; then grep ANTHROPIC_API_KEY /home/azureuser/convoca/.env >> $DEST/.env && chmod 600 $DEST/.env && echo '   copied'; else echo '   already present'; fi"

Write-Host "== install deps =="
ssh -i $KEY $VM "cd $DEST && npm ci --omit=dev 2>&1 | tail -2"

Write-Host "== (re)start pm2 app 'fondbih' ONLY =="
ssh -i $KEY $VM "cd $DEST && (pm2 restart ecosystem-ejn.config.cjs --update-env 2>/dev/null || pm2 start ecosystem-ejn.config.cjs) && pm2 save && pm2 status fondbih"

Write-Host "== health =="
$health = ssh -i $KEY $VM "curl -s http://localhost:3005/health"
Write-Host $health
$liveSha = ($health | ConvertFrom-Json).sha
if ($liveSha -ne $SHA) {
  Write-Host "!! DEPLOY NOT VERIFIED: /health reports sha $liveSha, expected $SHA"
  Write-Host "!! the running process is not serving the commit that was just pushed - do not report this as deployed"
  exit 1
}
Write-Host "== verified: production is serving $SHA =="
