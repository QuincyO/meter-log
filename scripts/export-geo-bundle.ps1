<#
.SYNOPSIS
  Export a portable OSRM + Nominatim bundle to an SSD.

.DESCRIPTION
  Run this ON THE MACHINE WHERE OSRM + NOMINATIM ALREADY WORK. It writes a
  self-contained folder you copy to an SSD, so another PC can run the planner's
  local road-matrix (OSRM) + geocoder (Nominatim) WITHOUT re-downloading the
  Ontario map or re-running the ~hour-long Nominatim import.

  What it captures:
    - OSRM  : the preprocessed .osrm* files ARE the output -> just copied.
    - OSRM  : the osrm/osrm-backend image -> saved to a tar (no pull on target).
    - Nominatim : the imported Postgres DB lives INSIDE the container, so we
                  `docker commit` the (stopped, cleanly shut down) container into
                  an image and `docker save` that. On the target the image's
                  `import-finished` marker makes it skip import and just serve.

.EXAMPLE
  .\export-geo-bundle.ps1 -Dest E:\geo-bundle
  (E: = your SSD; run the matching setup script on the new PC afterwards.)
#>
param(
  [Parameter(Mandatory=$true)] [string]$Dest,          # SSD bundle folder, e.g. E:\geo-bundle
  [string]$OsrmData = 'D:\osrm',                       # folder holding the .osrm* files
  [string]$OsrmBase = 'ontario-260721',                # basename of the .osrm files (no extension)
  [string]$NominatimContainer = 'nominatim',
  [string]$NominatimImage = 'nominatim-ontario:latest'
)
$ErrorActionPreference = 'Stop'
function Say($m){ Write-Host "==> $m" -ForegroundColor Cyan }

if (-not (Test-Path "$OsrmData\$OsrmBase.osrm")) {
  throw "No $OsrmBase.osrm in $OsrmData — check -OsrmData / -OsrmBase."
}
New-Item -ItemType Directory -Force -Path "$Dest\images","$Dest\osrm" | Out-Null

# 1. OSRM processed files — the finished graph, portable as-is.
Say "Copying OSRM files from $OsrmData ..."
Copy-Item "$OsrmData\$OsrmBase.osrm*" "$Dest\osrm\" -Force
$OsrmBase | Out-File "$Dest\osrm-basename.txt" -Encoding ascii

# 2. OSRM base image -> tar (target loads it instead of pulling).
Say "Saving osrm/osrm-backend image ..."
docker save osrm/osrm-backend -o "$Dest\images\osrm-backend.tar"

# 3. Nominatim — bake the imported DB into an image, then save it.
#    Stop first so Postgres shuts down cleanly (the image traps SIGTERM), giving
#    a consistent DB snapshot; restart it locally when we're done.
Say "Stopping Nominatim for a clean DB snapshot ..."
docker stop $NominatimContainer | Out-Null
Say "Committing imported DB to $NominatimImage ..."
docker commit $NominatimContainer $NominatimImage | Out-Null
Say "Saving Nominatim image (the big one — DB is baked in) ..."
docker save $NominatimImage -o "$Dest\images\nominatim-ontario.tar"
Say "Restarting Nominatim locally ..."
docker start $NominatimContainer | Out-Null

# 4. Drop the setup script next to the data so the SSD is self-contained.
if (Test-Path "$PSScriptRoot\setup-geo-on-new-pc.ps1") {
  Copy-Item "$PSScriptRoot\setup-geo-on-new-pc.ps1" "$Dest\" -Force
}

Say "Done. Bundle at: $Dest"
Write-Host "Copy that whole folder to the SSD, then on the new PC run setup-geo-on-new-pc.ps1 from it." -ForegroundColor Green
