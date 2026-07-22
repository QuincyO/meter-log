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
try { docker info *> $null } catch {
  Write-Host "Docker is installed but the engine isn't running. Start Docker Desktop, wait for it to go green, then re-run." -ForegroundColor Yellow
  return
}

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

# 4. (Re)start both containers.
docker rm -f osrm-ontario nominatim 2>$null | Out-Null
Say "Starting OSRM on :5000 ..."
docker run -d --restart unless-stopped -p 5000:5000 -v "${OsrmData}:/data" `
  osrm/osrm-backend osrm-routed --algorithm ch --max-table-size 1000 "/data/$base.osrm"
Say "Starting Nominatim on :8080 ..."
docker run -d --restart unless-stopped -p 8080:8080 nominatim-ontario:latest

Write-Host "`nDone. Give the containers ~30s, then smoke-test:" -ForegroundColor Green
Write-Host '  OSRM:      curl "http://localhost:5000/table/v1/driving/-79.37,45.05;-79.31,45.11?annotations=distance"'
Write-Host '  Nominatim: curl "http://localhost:8080/search?q=Bracebridge,ON&format=json"'
Write-Host "In planner.html, set OSRM = http://localhost:5000 and Geocoder = http://localhost:8080."
