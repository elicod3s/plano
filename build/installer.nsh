; PLANO — NSIS installer hooks (electron-builder includes this via nsis.include).
; Adds an "Open in PLANO" entry to the Windows Explorer right-click menu, on both a folder and
; the folder background (empty space inside a folder). The command launches PLANO with the folder
; path as its argument; the app then opens it as the workspace. Per-user (HKCU) so no admin is
; needed. Removed cleanly on uninstall.

!macro customInstall
  ; Right-click ON a folder
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInPlano" "" "Open in PLANO"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInPlano" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInPlano\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  ; Right-click on the BACKGROUND of an open folder
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInPlano" "" "Open in PLANO"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInPlano" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInPlano\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInPlano"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInPlano"
!macroend
