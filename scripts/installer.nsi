; Recovery implementation. The original installer source was not included.
Unicode true
RequestExecutionLevel user
; The original 0.10.7 installer also used non-solid Deflate.
SetCompressor zlib
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

Var UpdateMode
Var UpdatePid
Var UpdateDirectory

Name "${PRODUCT_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\shitu"
InstallDirRegKey HKCU "Software\local.shitu.desktop" "InstallDir"
VIProductVersion "${VERSION_QUAD}"
VIAddVersionKey /LANG=2052 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "FileDescription" "${PRODUCT_NAME}用户级安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" ""
!define MUI_ICON "${SOURCE_DIR}\resources\app\assets\icon.ico"
!define MUI_UNICON "${SOURCE_DIR}\resources\app\assets\icon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_NAME}.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  StrCpy $UpdateMode 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/SHITUUPDATE" $1
  IfErrors normal_init
  StrCpy $UpdateMode 1
  SetSilent silent
  ReadEnvStr $UpdatePid "SHITU_UPDATE_PID"
  ReadEnvStr $UpdateDirectory "SHITU_UPDATE_INSTALL_DIR"
  StrCmp $UpdatePid "" update_failed
  StrCmp $UpdateDirectory "" update_failed
  ; The caller supplies an existing installation and its own positive PID.
  IntFmt $0 "%u" $UpdatePid
  StrCmp $0 $UpdatePid 0 update_failed
  IntCmp $UpdatePid 0 update_failed update_failed +1
  GetFullPathName $0 "$UpdateDirectory"
  StrCmp $0 $UpdateDirectory 0 update_failed
  IfFileExists "$UpdateDirectory\${PRODUCT_NAME}.exe" +1 update_failed
  System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i $UpdatePid) p .r0 ?e'
  Pop $2
  StrCmp $0 0 process_already_exited
  System::Call 'kernel32::WaitForSingleObject(p r0, i 120000) i .r1'
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCmp $1 0 process_exited update_failed
process_already_exited:
  ; ERROR_INVALID_PARAMETER means the PID exited before OpenProcess ran.
  StrCmp $2 87 process_exited update_failed
process_exited:
  Sleep 500
  StrCpy $INSTDIR "$UpdateDirectory"
  Return
update_failed:
  SetErrorLevel 2
  Abort
normal_init:
FunctionEnd

Function .onInstSuccess
  ${If} $UpdateMode == 1
    Exec '"$INSTDIR\${PRODUCT_NAME}.exe"'
  ${EndIf}
FunctionEnd

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*"
  WriteUninstaller "$INSTDIR\卸载${PRODUCT_NAME}.exe"
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\卸载${PRODUCT_NAME}.lnk" "$INSTDIR\卸载${PRODUCT_NAME}.exe"
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  WriteRegStr HKCU "Software\local.shitu.desktop" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop" "DisplayIcon" "$INSTDIR\${PRODUCT_NAME}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop" "UninstallString" '"$INSTDIR\卸载${PRODUCT_NAME}.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ; Delete only files in this release, leaving user-created library files intact.
  !include "${UNINSTALL_LIST}"
  Delete "$INSTDIR\卸载${PRODUCT_NAME}.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\卸载${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local.shitu.desktop"
  DeleteRegKey HKCU "Software\local.shitu.desktop"
SectionEnd
