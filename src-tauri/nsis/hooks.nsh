; MyAgents NSIS Installer Hooks
; - PREINSTALL: Kill orphaned MyAgents sidecar processes before file replacement
;   Prevents file-lock failures when updating bun-x86_64-pc-windows-msvc.exe

!macro NSIS_HOOK_PREINSTALL
  ; Kill MyAgents bun sidecar processes (identified by --myagents-sidecar marker)
  ; Does NOT affect Claude Code or other bun processes
  DetailPrint "Cleaning up MyAgents background processes..."
  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*--myagents-sidecar*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'

  ; Kill SDK child processes spawned by MyAgents
  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*claude-agent-sdk*\" -and $_.CommandLine -like \"*.myagents*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'

  ; Kill MCP child processes from our installation (~/.myagents/mcp/)
  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*.myagents\mcp\*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'

  ; Remove bun.exe alias before upgrade — hardlink goes stale when the target exe is replaced
  Delete "$INSTDIR\bun.exe"

  ; Brief wait for processes to fully terminate and release file locks
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Create bun.exe hardlink for SDK subprocess compatibility.
  ; Tauri externalBin names the binary with target triple suffix (bun-x86_64-pc-windows-msvc.exe),
  ; but SDK uses which("bun") which only matches bun.exe/bun.cmd/bun.bat.
  ; Hardlink: zero extra disk space, same file, instant creation.
  IfFileExists "$INSTDIR\bun-x86_64-pc-windows-msvc.exe" 0 bun_alias_done
    IfFileExists "$INSTDIR\bun.exe" bun_alias_done 0
      nsExec::ExecToLog 'cmd /c mklink /H "$INSTDIR\bun.exe" "$INSTDIR\bun-x86_64-pc-windows-msvc.exe"'
      Pop $0
      ${If} $0 != 0
        ; Hardlink failed (e.g. non-NTFS), fall back to copy
        CopyFiles /SILENT "$INSTDIR\bun-x86_64-pc-windows-msvc.exe" "$INSTDIR\bun.exe"
      ${EndIf}
  bun_alias_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Clean up bun.exe alias created by POSTINSTALL (not in Tauri's externalBin list)
  Delete "$INSTDIR\bun.exe"
!macroend
