@echo off
:: myagents CLI wrapper for Windows cmd.exe
:: Invokes the Bun script via the bundled Bun runtime
setlocal

:: Try bundled Bun first (highest priority in agent PATH)
for %%b in (bun.exe) do (
  if not "%%~$PATH:b"=="" (
    "%%~$PATH:b" "%~dp0myagents" %*
    exit /b %ERRORLEVEL%
  )
)

:: Fallback to user-installed Bun
if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  "%USERPROFILE%\.bun\bin\bun.exe" "%~dp0myagents" %*
  exit /b %ERRORLEVEL%
)

echo Error: Bun runtime not found. This CLI requires the MyAgents app to be running.
exit /b 3
