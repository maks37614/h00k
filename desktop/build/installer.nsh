!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Assisted NSIS installer: preserve electron-builder's install/upgrade/uninstall.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL h00kShortcutCheck
Var /GLOBAL h00kShortcutWanted
!endif

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "h00k Desktop"
  !define MUI_WELCOMEPAGE_TEXT "h00k Desktop$\r$\n$\r$\nПідключіть h00k до MetaScalp, Tiger.Trade або Vataga.$\r$\n$\r$\nНатисніть Далі, щоб продовжити."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ; First-time default = checked. Respect the previous explicit choice on upgrade,
  ; including silent upgrades (the old shortcut alone is not an authoritative signal).
  StrCpy $h00kShortcutWanted "1"
  ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "H00kDesktopShortcutChoice"
  ${If} $R8 == "0"
    StrCpy $h00kShortcutWanted "0"
  ${EndIf}

  ; Headless /S installs support explicit shortcut choice for deployment and CI.
  ; These switches override the saved preference, but only for this install.
  ${GetParameters} $R8
  ${GetOptions} $R8 "/NO_DESKTOP_SHORTCUT" $R9
  ${IfNot} ${Errors}
    StrCpy $h00kShortcutWanted "0"
  ${EndIf}
  ${GetOptions} $R8 "/DESKTOP_SHORTCUT" $R9
  ${IfNot} ${Errors}
    StrCpy $h00kShortcutWanted "1"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER

!macro customPageAfterChangeDir
  Page custom h00kShortcutPageCreate h00kShortcutPageLeave
!macroend

Function h00kShortcutPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 2u 100% 24u "h00k Desktop - ярлик на робочому столі"
  Pop $1
  ${NSD_CreateLabel} 0 27u 100% 30u "Виберіть, чи потрібно додати ярлик із роботом h00k на робочий стіл Windows."
  Pop $1
  ${NSD_CreateCheckbox} 0 70u 100% 18u "Створити ярлик h00k на робочому столі"
  Pop $h00kShortcutCheck
  ${If} $h00kShortcutWanted == "1"
    ${NSD_Check} $h00kShortcutCheck
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function h00kShortcutPageLeave
  ${NSD_GetState} $h00kShortcutCheck $h00kShortcutWanted
FunctionEnd

!endif ; BUILD_UNINSTALLER

!macro customInstall
  ; electron-builder creates the normal AppUserModelID-aware shortcut first.
  ${If} $h00kShortcutWanted != "1"
    Delete "$newDesktopLink"
    Delete "$oldDesktopLink"
  ${Else}
    ; Electron-builder may preserve existing shortcuts during an upgrade, or
    ; skip recreating one that the user previously opted out of. Restore it
    ; only when explicitly requested and the standard builder step omitted it.
    ${IfNot} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  ${EndIf}
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "H00kDesktopShortcutChoice" "$h00kShortcutWanted"
!macroend
