# Writes .env for a LOCAL trial with docker-compose.local.yml (random secrets, Mailpit as SMTP).
# Run from the repository root:  powershell -ExecutionPolicy Bypass -File ops\local\setup.ps1
$ErrorActionPreference = 'Stop'
$envPath = Join-Path (Get-Location) '.env'
if (Test-Path $envPath) { Write-Host ".env already exists - not overwritten. Delete it first to start over."; exit 1 }

function New-Hex([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buffer)
  -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

$adminPassword = New-Hex 10
$lines = @(
  'APP_DOMAIN=localhost',
  'APP_URL=https://localhost:8443',
  'DB_OWNER_USER=bidmanager_owner',
  "DB_OWNER_PASSWORD=$(New-Hex 24)",
  'DB_APP_USER=bidmanager_app',
  "DB_APP_PASSWORD=$(New-Hex 24)",
  "FILE_ENCRYPTION_KEY=$(New-Hex 32)",
  'SMTP_HOST=mailpit',
  'SMTP_PORT=1025',
  'SMTP_SECURE=false',
  'SMTP_USER=',
  'SMTP_PASS=',
  'SMTP_FROM=Bid Manager <no-reply@localhost>',
  'SESSION_IDLE_MINUTES=30',
  'LOG_LEVEL=info',
  'RUN_MIGRATIONS=1',
  'SEED_ORG_NAME=Active Computer Systems',
  'SEED_ADMIN_EMAIL=admin@example.gr',
  "SEED_ADMIN_PASSWORD=$adminPassword"
)
# UTF-8 without BOM: a BOM would corrupt the first variable name.
[System.IO.File]::WriteAllLines($envPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $envPath"
Write-Host "Admin login:  admin@example.gr  /  $adminPassword"
