; Releases before the opt-in switch wrote a hotkey to this Start menu link.
; Clear only that field, once during installation, for our own executable.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R7 HKCU "${MANUPRODUCTKEY}" "StartMenuHotkeyMigration"
  ${If} $R7 != "1"
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R7
    ${If} $R7 = 1
      !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
      ${If} $0 P<> 0
        ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
        ${If} $1 P<> 0
          ${IPersistFile::Load} $1 '("$SMPROGRAMS\${PRODUCTNAME}.lnk", ${STGM_READWRITE})i.r2'
          ${If} $2 = 0
            ${IShellLink::GetHotkey} $0 '(.r3)i.r2'
            ${If} $2 = 0
              ${If} $3 != 0
                ${IShellLink::SetHotkey} $0 '(0)i.r2'
                ${If} $2 = 0
                  ${IPersistFile::Save} $1 '("$SMPROGRAMS\${PRODUCTNAME}.lnk",1)i.r2'
                ${EndIf}
              ${EndIf}
              ${If} $2 = 0
                WriteRegStr HKCU "${MANUPRODUCTKEY}" "StartMenuHotkeyMigration" "1"
              ${EndIf}
            ${EndIf}
          ${EndIf}
          ${IUnknown::Release} $1 ""
        ${EndIf}
        ${IUnknown::Release} $0 ""
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
