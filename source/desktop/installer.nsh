!macro customInit
  ; The old desktop app intercepts WM_CLOSE and can keep both Electron and the
  ; local backend alive. Stop only this application's named processes before
  ; electron-builder performs its normal running-app check.
  nsExec::ExecToLog 'taskkill.exe /IM "AI Chatbot.exe" /T /F'
  nsExec::ExecToLog 'taskkill.exe /IM "chatbot-backend.exe" /T /F'

  ; Version 1.0.0 has a custom uninstall prompt which ignores silent-upgrade
  ; flags and repeatedly asks whether chat data should be deleted. For an
  ; upgrade, replace only the registered uninstall command with a no-op helper.
  ; The installer then overwrites the application files in place and writes the
  ; new 1.1.1 uninstaller/registry values. User data under LocalAppData is never
  ; touched.
  InitPluginsDir
  File /oname=$PLUGINSDIR\upgrade-noop.exe "${PROJECT_DIR}\desktop\upgrade-noop.exe"

  ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R0 != ""
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "LegacyUninstallString" $R0
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString" '"$PLUGINSDIR\upgrade-noop.exe"'
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString" '"$PLUGINSDIR\upgrade-noop.exe"'
  ${EndIf}
!macroend

!macro customInstall
  DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "LegacyUninstallString"
!macroend
