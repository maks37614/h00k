!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Assisted NSIS installer: preserve electron-builder's install/upgrade/uninstall.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL h00kShortcutCheck
Var /GLOBAL h00kShortcutWanted
!endif

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "h00k Desktop"
  !define MUI_WELCOMEPAGE_TEXT "Smart Dock$\r$\n$\r$\nПідключіть h00k до MetaScalp, Tiger.Trade або Vataga.$\r$\n$\r$\nНатисніть Далі, щоб продовжити."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ; Checked by default; users can decline on the following page.
  StrCpy $h00kShortcutWanted "1"
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
  ; electron-builder creates it, then we remove it ONLY when unchecked.
  ; Standard uninstall takes care of shortcut cleanup and Start menu.
  ${If} $h00kShortcutWanted != "1"
    Delete "$newDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend
