Param(
    [string]$PfxPath = $Env:CSC_LINK,
    [string]$PfxPassword = $Env:CSC_KEY_PASSWORD,
    [string]$Publisher = $Env:CSC_NAME,
    [string]$Timestamp = $(if ($Env:WIN_RFC3161_TIMESTAMP_SERVER) { $Env:WIN_RFC3161_TIMESTAMP_SERVER } else { "http://timestamp.sectigo.com" }),
    [switch]$Arm64 = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "[win-build-sign] Preparing environment..."

# Prefer PFX if provided and not 'none'; otherwise use Cert Store
$pfxNorm = ("" + $PfxPath).Trim()
if (![string]::IsNullOrWhiteSpace($pfxNorm) -and $pfxNorm.ToLower() -ne 'none') {
    $Env:CSC_LINK = $pfxNorm
    $fileExists = Test-Path -LiteralPath $pfxNorm
    if ([string]::IsNullOrWhiteSpace($PfxPassword) -and $fileExists) {
        throw "CSC_LINK points to a file but CSC_KEY_PASSWORD is empty. Provide -PfxPassword or set CSC_KEY_PASSWORD."
    }
    if ($fileExists) { $Env:CSC_KEY_PASSWORD = $PfxPassword }
    # Ensure we don't force Cert Store mode
    Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
    if (![string]::IsNullOrWhiteSpace($Publisher)) { $Env:CSC_NAME = $Publisher }
    Write-Host "[win-build-sign] Using PFX from: $pfxNorm"
} else {
    # Use Windows Certificate Store via CSC_LINK=none (do NOT set WIN_CSC_LINK)
    try { Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue } catch {}
    $Env:WIN_CSC_LINK = ''
    [System.Environment]::SetEnvironmentVariable('WIN_CSC_LINK', $null, 'Process')
    $Env:CSC_LINK = 'none'
    if (![string]::IsNullOrWhiteSpace($Publisher)) { $Env:CSC_NAME = $Publisher }
    Write-Host "[win-build-sign] Using Windows Certificate Store (CSC_LINK=none)."
}

$Env:WIN_RFC3161_TIMESTAMP_SERVER = $Timestamp
Write-Host "[win-build-sign] RFC3161 timestamp server: $Timestamp"

# Debug print effective signing env (safe subset)
Write-Host ("[win-build-sign] Env check: WIN_CSC_LINK='" + ($Env:WIN_CSC_LINK) + "' CSC_LINK='" + ($Env:CSC_LINK) + "' CSC_NAME='" + ($Env:CSC_NAME) + "'")

Write-Host "[win-build-sign] Building production bundle with auto-update..."
npm run build-prod-upgrade

Write-Host "[win-build-sign] Packaging Windows NSIS installer..."
$archArgs = "--x64"
if ($Arm64.IsPresent) { $archArgs = "$archArgs --arm64" }

# Run via cmd to hard-clear WIN_CSC_LINK for child process if using Cert Store
if ($pfxNorm -and $pfxNorm.ToLower() -ne 'none') {
    npx --yes electron-builder --win nsis $archArgs --publish=never
} else {
    $cmd = 'set "WIN_CSC_LINK=" & set "CSC_LINK=none" & npx --yes electron-builder --win nsis ' + $archArgs + ' --publish=never'
    & cmd /c $cmd
}

Write-Host "[win-build-sign] Done. Artifacts in 'release\\' with signed installer if certificate was available."

