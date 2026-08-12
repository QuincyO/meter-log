<#
.SYNOPSIS
  Set up the planner's local OSRM + Nominatim on a NEW PC from an SSD bundle.

.DESCRIPTION
  Run this FROM THE BUNDLE FOLDER on the SSD (the folder export-geo-bundle.ps1
  produced). It installs Docker Desktop if missing, loads the prebuilt images,
  copies the OSRM files locally, and starts both containers. No map download and
  no Nominatim import — the DB is already baked into the image.

  Run in an elevated (Admin) PowerShell:
    Set-ExecutionPolicy -Scope Process Bypass -Force   # if scripts are blocked
    .\setup-geo-on-new-pc.ps1

.NOTES
  If Docker isn't installed the script installs it, then STOPS: you must launch
  Docker Desktop once (it may prompt for a WSL2 update / reboot) and re-run.

  On an ARM64 PC the bundled amd64 images run under emulation. OSRM is fine, but
  Nominatim's apache2 crashes there, so the script builds arm64-patch\ into a
  variant image that serves the same DB through Nominatim's Python API server.
  Expect Nominatim to take a few minutes to answer on such a machine.
#>
param(
  [string]$Bundle   = $PSScriptRoot,     # the SSD bundle folder (defaults to where this script sits)
  [string]$OsrmData = 'C:\osrm'          # local folder to copy the OSRM files into
)
$ErrorActionPreference = 'Stop'
function Say($m){ Write-Host "==> $m" -ForegroundColor Cyan }

# 1. Docker Desktop.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Say "Docker not found — installing Docker Desktop via winget ..."
  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
  Write-Host "`nDocker Desktop installed. Launch it once (accept the WSL2 update / reboot if asked), then re-run this script." -ForegroundColor Yellow
  return
}
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker is installed but the engine isn't running. Start Docker Desktop, wait for it to go green, then re-run." -ForegroundColor Yellow
  return
}
$hostArch = docker info --format '{{.Architecture}}'

# 2. Load the prebuilt images (fast local read from the SSD — no network).
Say "Loading OSRM image ..."
docker load -i "$Bundle\images\osrm-backend.tar"
Say "Loading Nominatim image (imported DB baked in) ..."
docker load -i "$Bundle\images\nominatim-ontario.tar"

# 3. Copy OSRM files off the SSD (OSRM bind-mounts these from a local disk).
$base = (Get-Content "$Bundle\osrm-basename.txt").Trim()
New-Item -ItemType Directory -Force -Path $OsrmData | Out-Null
Say "Copying OSRM data to $OsrmData ..."
Copy-Item "$Bundle\osrm\*" $OsrmData -Force

# 4. On an ARM64 PC the bundled amd64 images run under emulation, and Nominatim's
#    apache2 dies there with "QEMU internal SIGSEGV". Build the drop-in image that
#    serves the same baked-in DB via Nominatim's Python API server instead.
$nominatimImage = 'nominatim-ontario:latest'
if ($hostArch -match 'aarch64|arm64') {
  Say "ARM64 host — building the emulation-safe Nominatim frontend ..."
  docker build --platform linux/amd64 -t nominatim-ontario:arm64-host "$Bundle\arm64-patch"
  $nominatimImage = 'nominatim-ontario:arm64-host'
}

# 5. (Re)start both containers.
foreach ($c in 'osrm-ontario','nominatim') {
  if (docker ps -aq -f ('name=^' + $c + '$')) { docker rm -f $c | Out-Null }
}
# CH needs a .hsgr file. This bundle was prepared for MLD, so match the algorithm
# to whatever the data actually contains.
$algorithm = if (Test-Path "$OsrmData\$base.osrm.hsgr") { 'ch' } else { 'mld' }
Say "Starting OSRM on :5000 (algorithm $algorithm) ..."
docker run -d --name osrm-ontario --restart unless-stopped -p 5000:5000 -v "${OsrmData}:/data" `
  osrm/osrm-backend osrm-routed --algorithm $algorithm --max-table-size 1000 "/data/$base.osrm"
Say "Starting Nominatim on :8080 ..."
docker run -d --name nominatim --restart unless-stopped -p 8080:8080 $nominatimImage

# 6. Don't claim success until both actually answer.
function Wait-Endpoint($Name, $Url, $TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod $Url -TimeoutSec 20 | Out-Null
      Write-Host "  $Name is answering." -ForegroundColor Green
      return $true
    } catch { Start-Sleep -Seconds 5 }
  }
  Write-Host "  $Name did not answer within $TimeoutSec s - check 'docker logs'." -ForegroundColor Yellow
  return $false
}
Say "Waiting for the containers (Nominatim takes a few minutes on an ARM64 PC) ..."
$osrmOk = Wait-Endpoint 'OSRM' 'http://localhost:5000/table/v1/driving/-79.37,45.05;-79.31,45.11?annotations=distance' 180
$nomOk  = Wait-Endpoint 'Nominatim' 'http://localhost:8080/search?q=Bracebridge,ON&format=json' 600

if ($osrmOk -and $nomOk) {
  Write-Host "`nDone - both services are up." -ForegroundColor Green
} else {
  Write-Host "`nSetup finished, but not everything came up. Inspect with:" -ForegroundColor Yellow
  Write-Host '  docker ps -a ; docker logs osrm-ontario ; docker logs nominatim'
}
Write-Host "In planner.html, set OSRM = http://localhost:5000 and Geocoder = http://localhost:8080."
