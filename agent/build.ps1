param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\public\agent")
)

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "highseas-monitor"
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null

$previousGoOs = $env:GOOS
$previousGoArch = $env:GOARCH
$previousCgo = $env:CGO_ENABLED
try {
  $env:GOOS = "linux"
  $env:CGO_ENABLED = "0"
  Push-Location $source
  try {
    foreach ($architecture in @("amd64", "arm64")) {
      $env:GOARCH = $architecture
      $target = Join-Path $OutputDirectory "highseas-monitor-linux-$architecture"
      & go build -trimpath -ldflags "-s -w" -o $target .
      if ($LASTEXITCODE -ne 0) { throw "Go build failed for $architecture" }
    }
  } finally {
    Pop-Location
  }
} finally {
  $env:GOOS = $previousGoOs
  $env:GOARCH = $previousGoArch
  $env:CGO_ENABLED = $previousCgo
}

$checksumLines = Get-ChildItem -LiteralPath $OutputDirectory -Filter "highseas-monitor-linux-*" |
  Sort-Object Name |
  ForEach-Object { "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(), $_.Name }
$checksumPath = Join-Path $OutputDirectory "SHA256SUMS.txt"
[System.IO.File]::WriteAllText($checksumPath, (($checksumLines -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
