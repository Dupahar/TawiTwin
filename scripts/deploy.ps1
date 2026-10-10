# Build + deploy the SAM stack, then publish the static site to S3 and invalidate CloudFront.
# Usage (from repo root):  ./scripts/deploy.ps1   [-SiteOnly]
param([switch]$SiteOnly)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not $SiteOnly) {
        & "$PSScriptRoot/vendor_agent.ps1"
        sam build
        if ($LASTEXITCODE -ne 0) { throw "sam build failed" }
        $officerKey = (Get-Content "$root/.env" | Where-Object { $_ -like "OFFICER_KEY=*" }) -replace "^OFFICER_KEY=", ""
        sam deploy --parameter-overrides "OfficerKey=$officerKey"
        if ($LASTEXITCODE -ne 0) { throw "sam deploy failed" }
    }

    $outputs = aws cloudformation describe-stacks --stack-name tawi-twin `
        --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
    $out = @{}; foreach ($o in $outputs) { $out[$o.OutputKey] = $o.OutputValue }

    # Mapbox public token (pk.*, URL-restricted) is optional: without it the site falls back to MapLibre + OpenFreeMap
    $mapbox = (Get-Content "$root/.env" | Where-Object { $_ -like "MAPBOX_TOKEN=*" }) -replace "^MAPBOX_TOKEN=", ""
    $cfg = @{ apiUrl = $out.ApiUrl }
    if ($mapbox) { $cfg.mapboxToken = $mapbox }
    $cfg | ConvertTo-Json | Set-Content -Encoding utf8 site/config.json

    $bucket = "s3://$($out.SiteBucketName)"
    aws s3 sync site $bucket --delete --exclude "*.geojson" --exclude "tiles/*"
    if ($LASTEXITCODE -ne 0) { throw "s3 sync failed" }
    # .geojson is unknown to the mime guesser; application/json lets CloudFront gzip/brotli it
    aws s3 cp site $bucket --recursive --exclude "*" --include "*.geojson" --content-type application/json --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "s3 cp (geojson) failed" }
    # vector tiles are pre-gzipped by scripts/buildings_risk.py
    aws s3 sync site/tiles "$bucket/tiles" --delete --content-encoding gzip --content-type application/x-protobuf `
        --cache-control "public, max-age=86400" --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "s3 sync (tiles) failed" }
    aws cloudfront create-invalidation --distribution-id $out.DistributionId --paths "/*" | Out-Null

    Write-Host "Site: $($out.SiteUrl)"
    Write-Host "API:  $($out.ApiUrl)"
}
finally { Pop-Location }
