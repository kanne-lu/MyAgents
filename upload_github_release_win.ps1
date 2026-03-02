# 上传 Windows 构建产物（NSIS .exe）到 GitHub Release
# 可独立运行，也被 publish_windows.ps1 调用
#
# 用法: .\upload_github_release_win.ps1

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

# 读取版本号
$TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $TauriConf.version

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  上传 Windows 产物到 GitHub Release" -ForegroundColor Cyan
Write-Host "  Version: v$Version" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 gh CLI
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCmd) {
    Write-Host "[X] gh CLI 未安装" -ForegroundColor Red
    Write-Host "    安装: winget install --id GitHub.cli" -ForegroundColor Yellow
    exit 1
}

# 查找 NSIS .exe 文件
$TargetDir = Join-Path $ProjectDir "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
$NsisExe = Get-ChildItem -Path $TargetDir -Filter "*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "portable" } | Select-Object -First 1

if (-not $NsisExe) {
    Write-Host "[X] 未找到 NSIS 安装包" -ForegroundColor Red
    Write-Host "    请先运行 .\build_windows.ps1 完成构建" -ForegroundColor Yellow
    exit 1
}

Write-Host "  [OK] $($NsisExe.Name)" -ForegroundColor Green
Write-Host ""

# 检查 Release 是否存在
$releaseCheck = & gh release view "v$Version" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] GitHub Release v$Version 不存在" -ForegroundColor Red
    Write-Host "    请先通过 merge-release 流程创建 Release" -ForegroundColor Yellow
    exit 1
}

# 上传
Write-Host "上传到 GitHub Release v$Version..." -ForegroundColor Cyan
& gh release upload "v$Version" $NsisExe.FullName --clobber
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "[OK] GitHub Release 上传完成" -ForegroundColor Green
    Write-Host "  - $($NsisExe.Name)" -ForegroundColor White
} else {
    Write-Host "[X] 上传失败" -ForegroundColor Red
    exit 1
}
