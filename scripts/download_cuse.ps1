#Requires -Version 5.1
<#
.SYNOPSIS
    Fetch the latest cuse (computer-use MCP) binary from GitHub Releases and
    install it under src-tauri\binaries\ using Tauri's externalBin naming
    convention (binary-<target-triple>).

.DESCRIPTION
    Downloads cuse-v{VERSION}-windows-x64.zip from hAcKlyc/MyAgents-Cuse via
    the gh CLI (works for both public and private visibility), verifies
    SHA-256, and extracts cuse.exe as cuse-x86_64-pc-windows-msvc.exe.

.EXAMPLE
    .\scripts\download_cuse.ps1                 # Download latest
    .\scripts\download_cuse.ps1 -Version v0.2.0 # Specific version
    .\scripts\download_cuse.ps1 -Force          # Re-download even if up-to-date
    .\scripts\download_cuse.ps1 -Clean          # Remove existing first
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [switch]$Force,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$Repo = "hAcKlyc/MyAgents-Cuse"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$BinariesDir = Join-Path $ProjectDir "src-tauri\binaries"
$VersionMarker = Join-Path $BinariesDir ".cuse-version"
$TargetTriple = "x86_64-pc-windows-msvc"
$TargetBinary = Join-Path $BinariesDir "cuse-$TargetTriple.exe"

function Write-Info { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Green }
function Write-Warn2 { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Red }

# ── Preflight ─────────────────────────────────────────────────────────────

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Err "gh CLI not found. Install: https://cli.github.com/"
    exit 1
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Err "gh not authenticated. Run: gh auth login"
    exit 1
}

if (-not (Test-Path $BinariesDir)) {
    New-Item -ItemType Directory -Path $BinariesDir -Force | Out-Null
}

if ($Clean) {
    Write-Info "Cleaning existing cuse binaries..."
    Get-ChildItem $BinariesDir -Filter "cuse-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force
    if (Test-Path $VersionMarker) { Remove-Item $VersionMarker -Force }
}

# ── Resolve version ───────────────────────────────────────────────────────

if (-not $Version) {
    Write-Info "Querying latest cuse release from $Repo..."
    $Version = (gh release view --repo $Repo --json tagName -q .tagName 2>$null) -as [string]
    if (-not $Version) {
        Write-Err "Failed to query latest release. Check gh auth and repo access."
        exit 1
    }
}
$Version = $Version.Trim()

# Defensive: reject unusual tag shapes before they flow into filenames and
# shell strings. Normal cuse tags are `vMAJOR.MINOR.PATCH[-PRERELEASE]`.
if ($Version -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$') {
    Write-Err "Refusing unsafe version string: $Version"
    exit 1
}

Write-Info "Target version: $Version"

# Short-circuit if already up-to-date AND the installed binary passes a
# PE-header smoke check. A bare version-marker match is insufficient — a
# prior run killed mid-copy can leave the marker from an earlier success
# next to a truncated file.
if (-not $Force -and (Test-Path $VersionMarker)) {
    $current = (Get-Content $VersionMarker -Raw).Trim()
    if ($current -eq $Version -and (Test-Path $TargetBinary)) {
        $ok = $false
        try {
            $fs = [System.IO.File]::OpenRead($TargetBinary)
            $buf = New-Object byte[] 2
            $read = $fs.Read($buf, 0, 2)
            $fs.Close()
            if ($read -eq 2 -and $buf[0] -eq 0x4D -and $buf[1] -eq 0x5A) { $ok = $true }
        } catch { $ok = $false }
        if ($ok) {
            Write-Ok "cuse $Version already present, skipping download (use -Force to re-download)"
            exit 0
        }
        Write-Warn2 "Marker says $Version but binary is missing/corrupt - re-downloading"
    }
}

# ── Download ──────────────────────────────────────────────────────────────

$ArchiveName = "cuse-${Version}-windows-x64.zip"
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "myagents-cuse-$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    Write-Info "Downloading $ArchiveName + .sha256..."
    gh release download $Version `
        --repo $Repo `
        --pattern $ArchiveName `
        --pattern "$ArchiveName.sha256" `
        --dir $TmpDir `
        --clobber
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Download failed. Asset may not exist for $Version."
        exit 1
    }

    # ── Verify checksum ───────────────────────────────────────────────────

    Write-Info "Verifying SHA-256..."
    $ArchivePath = Join-Path $TmpDir $ArchiveName
    $HashFile = Join-Path $TmpDir "$ArchiveName.sha256"
    $expected = ((Get-Content $HashFile -Raw) -split '\s+')[0].Trim().ToLower()
    $actual = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLower()

    if ($expected -ne $actual) {
        Write-Err "SHA-256 mismatch!"
        Write-Err "  expected: $expected"
        Write-Err "  actual:   $actual"
        exit 1
    }
    Write-Ok "SHA-256 verified"

    # ── Extract and install ───────────────────────────────────────────────

    Write-Info "Extracting..."
    $ExtractDir = Join-Path $TmpDir "extract"
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $SrcBin = Join-Path $ExtractDir "cuse.exe"
    if (-not (Test-Path $SrcBin)) {
        # Some zip layouts nest under a subdir — find it
        $SrcBin = Get-ChildItem $ExtractDir -Recurse -Filter "cuse.exe" -File | Select-Object -First 1 -ExpandProperty FullName
        if (-not $SrcBin) {
            Write-Err "Archive does not contain cuse.exe"
            exit 1
        }
    }

    # Install atomically: copy to per-PID tmp next to the target on the
    # same filesystem, then Move-Item -Force into place. A kill between
    # copy and move leaves the old binary intact; a kill after move but
    # before marker write leaves a fresh binary with a stale marker —
    # next run's MZ-header check will either pass (fine) or fail (re-
    # download). Marker is written LAST so we never falsely report
    # up-to-date after an interrupted install.
    $TmpTarget = "$TargetBinary.tmp.$PID"
    Copy-Item $SrcBin $TmpTarget -Force
    Move-Item -Path $TmpTarget -Destination $TargetBinary -Force

    Set-Content -Path $VersionMarker -Value $Version -NoNewline

    Write-Ok "cuse $Version installed:"
    Write-Ok "  $TargetBinary"
} finally {
    if (Test-Path $TmpDir) {
        Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
