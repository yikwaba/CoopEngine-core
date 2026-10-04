param(
    [Parameter(Mandatory=$true)][string]$SourcePath,
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceSha
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $ProjectPath).Path
$source = (Resolve-Path $SourcePath).Path
$envFile = Join-Path $root '.staging\compose.env'
if (!(Test-Path $envFile)) { throw 'Existing recovery project and private compose.env are required.' }
$settings = [IO.File]::ReadAllText($envFile)
if ([regex]::Matches($settings, '(?m)^STAGING_SOURCE_SHA=.*$').Count -ne 1) {
    throw 'Expected exactly one STAGING_SOURCE_SHA setting.'
}
$compose = @('compose', '--project-name', 'coopengine-recovery-staging', '--env-file', $envFile, '-f', (Join-Path $root 'staging\compose.yml'))
function Invoke-RecoveryDocker {
    param([string[]]$DockerArgs)
    & docker @compose @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw 'A recovery Docker step failed. Stop here; do not delete any volumes or backups.' }
}
Push-Location $root
try {
    # Copy this batch's source directories. Private configuration and volumes
    # are outside these paths. Staff and member web clients use the rebuilt image.
    foreach ($relative in @('apps\api', 'apps\portal', 'apps\member-pwa', 'packages\db', 'scripts\staging')) {
        if (!(Test-Path (Join-Path $source $relative))) { throw "Missing source directory: $relative" }
    }
    foreach ($relative in @('apps\api', 'apps\portal', 'apps\member-pwa', 'packages\db', 'scripts\staging')) {
        Copy-Item (Join-Path $source "$relative\*") (Join-Path $root $relative) -Recurse -Force
    }
    $settings = [regex]::Replace($settings, '(?m)^STAGING_SOURCE_SHA=.*$', "STAGING_SOURCE_SHA=$SourceSha")
    [IO.File]::WriteAllText($envFile, $settings, [Text.UTF8Encoding]::new($false))
    Invoke-RecoveryDocker -DockerArgs @('config', '--quiet')
    Invoke-RecoveryDocker -DockerArgs @('build', 'api')

    Invoke-RecoveryDocker -DockerArgs @('up', '-d', '--wait', '--wait-timeout', '180', 'postgres')

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = Join-Path $root '.staging\backups'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $containerBackup = "/tmp/recovery-$stamp.dump"
    $backupFile = Join-Path $backupDir "recovery-$stamp.dump"
    Invoke-RecoveryDocker -DockerArgs @('exec', '-T', 'postgres', 'pg_dump', '-U', 'staging_admin', '-d', 'coopengine_staging', '-Fc', '-f', $containerBackup)
    Invoke-RecoveryDocker -DockerArgs @('exec', '-T', 'postgres', 'pg_restore', '--list', $containerBackup) | Out-Null
    Invoke-RecoveryDocker -DockerArgs @('cp', "postgres:$containerBackup", $backupFile)
    if (!(Test-Path $backupFile) -or (Get-Item $backupFile).Length -eq 0) { throw 'Local database backup was not saved.' }
    Write-Host "Database backup saved: $backupFile"

    Invoke-RecoveryDocker -DockerArgs @('stop', 'api', 'portal', 'member')
    # Apply append-only migrations without reseeding users, passwords or RBAC.
    Invoke-RecoveryDocker -DockerArgs @('run', '--rm', '--no-deps', 'migrate', 'bash', '-c', 'node scripts/staging/guard.mjs && cd packages/db && pnpm db:migrate && cd /app && node scripts/staging/grants.mjs')
    Invoke-RecoveryDocker -DockerArgs @('up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'api', 'portal')
    Invoke-RecoveryDocker -DockerArgs @('up', '-d', '--no-deps', 'member', 'gateway')
    Invoke-RecoveryDocker -DockerArgs @('restart', 'gateway')
    Invoke-RecoveryDocker -DockerArgs @('run', '--rm', '--no-deps', 'fixtures', 'node', 'scripts/staging/recovery-smoke.mjs')
    Invoke-RecoveryDocker -DockerArgs @('run', '--rm', '--no-deps', 'fixtures', 'node', 'scripts/staging/exact-money-smoke.mjs')
    foreach ($url in @('http://localhost:4310/login', 'http://localhost:4320/login')) {
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            try {
                $page = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
                if ($page.StatusCode -eq 200) { $ready = $true; break }
            } catch { }
            Start-Sleep -Seconds 2
        }
        if (!$ready) { throw "A local login page did not load: $url. Inspect gateway and web container logs." }
    }
    Write-Host 'RECOVERY UPDATE PASSED. API checks and both login pages passed. Production was not changed.'
} finally { Pop-Location }
