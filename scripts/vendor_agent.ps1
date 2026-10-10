# Assemble the agent Lambda package for Linux arm64 (SAM's resolver on Windows pulls Windows-only wheels).
# Output: .build/agent (app.py + dependencies). Run before `sam build` (deploy.ps1 does it).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root ".build/agent"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
& "$root/.venv/Scripts/python.exe" -m uv pip install --quiet --target $out `
    --python-platform aarch64-manylinux2014 --python-version 3.13 --only-binary :all: `
    -r "$root/backend/agent/requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "uv vendor failed" }
# boto3/botocore are kept on purpose: Strands needs a newer botocore than the runtime may bundle.
Copy-Item "$root/backend/agent/app.py" $out
