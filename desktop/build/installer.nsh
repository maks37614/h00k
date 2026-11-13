!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Assisted NSIS installer: preserve electron-builder's install/upgrade/uninstall.
Var /GLOBAL h00kShortcutCheck
Var /GLOBAL h00kShortcutWanted

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "h00k Desktop"
  !define MUI_WELCOMEPAGE_TEXT "Smart Dock$\r$\n$\r$\nConnect h00k to MetaScalp, Tiger.Trade, or Vataga.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ; Checked by default; users can decline on the following page.
  StrCpy $h00kShortcutWanted "1"
!macroend

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
  ${NSD_CreateLabel} 0 2u 100% 24u "h00k Desktop - desktop shortcut"
  Pop $1
  ${NSD_CreateLabel} 0 27u 100% 30u "Choose whether to add the robot h00k icon to your Windows desktop."
  Pop $1
  ${NSD_CreateCheckbox} 0 70u 100% 18u "Create a desktop shortcut (h00k)"
  Pop $h00kShortcutCheck
  ${If} $h00kShortcutWanted == "1"
    ${NSD_Check} $h00kShortcutCheck
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function h00kShortcutPageLeave
  ${NSD_GetState} $h00kShortcutCheck $h00kShortcutWanted
FunctionEnd

!macro customInstall
  ; electron-builder creates it, then we remove it ONLY when unchecked.
  ; Standard uninstall takes care of shortcut cleanup and Start menu.
  ${If} $h00kShortcutWanted != "1"
    Delete "$newDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend
