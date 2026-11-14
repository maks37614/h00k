!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "${__FILEDIR__}\installer-locales.nsh"

; The installer language selector is the first page. English is the default.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL h00kShortcutCheck
Var /GLOBAL h00kShortcutWanted
Var /GLOBAL h00kRadioEn
Var /GLOBAL h00kRadioPl
Var /GLOBAL h00kRadioRu
Var /GLOBAL h00kRadioUk
!endif

!macro customWelcomePage
  Page custom h00kLanguagePageCreate h00kLanguagePageLeave
  !define MUI_WELCOMEPAGE_TITLE "h00k Desktop"
  !define MUI_WELCOMEPAGE_TEXT "$(h00kWelcome)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ; English by default independent of the Windows locale.
  ; On upgrades, respect the last explicit installation language.
  StrCpy $LANGUAGE 1033
  ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "H00kInstallerLanguage"
  ${If} $R8 == "1045"
    StrCpy $LANGUAGE 1045
  ${ElseIf} $R8 == "1049"
    StrCpy $LANGUAGE 1049
  ${ElseIf} $R8 == "1058"
    StrCpy $LANGUAGE 1058
  ${EndIf}
  ; /H00K_LANG=en|pl|ru|uk for silent installations and Windows CI.
  ${GetParameters} $R8
  ${GetOptions} $R8 "/H00K_LANG=" $R9
  ${IfNot} ${Errors}
    ${If} $R9 == "en"
      StrCpy $LANGUAGE 1033
    ${ElseIf} $R9 == "pl"
      StrCpy $LANGUAGE 1045
    ${ElseIf} $R9 == "ru"
      StrCpy $LANGUAGE 1049
    ${ElseIf} $R9 == "uk"
      StrCpy $LANGUAGE 1058
    ${EndIf}
  ${EndIf}

  StrCpy $h00kShortcutWanted "1"
  ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "H00kDesktopShortcutChoice"
  ${If} $R8 == "0"
    StrCpy $h00kShortcutWanted "0"
  ${EndIf}
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

!macro customUnInit
  ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "H00kInstallerLanguage"
  ${If} $R8 == "1033"
    StrCpy $LANGUAGE 1033
  ${ElseIf} $R8 == "1045"
    StrCpy $LANGUAGE 1045
  ${ElseIf} $R8 == "1049"
    StrCpy $LANGUAGE 1049
  ${ElseIf} $R8 == "1058"
    StrCpy $LANGUAGE 1058
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER

!macro customPageAfterChangeDir
  Page custom h00kShortcutPageCreate h00kShortcutPageLeave
!macroend

!macro customFinishPage
  ; Three translated post-install help pages before the native Finish page.
  Page custom h00kGuideBasicsCreate
  Page custom h00kGuideLayoutCreate
  Page custom h00kGuideApiCreate
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend

Function h00kLanguagePageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(h00kLanguageTitle)" "$(h00kLanguageSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 3u 100% 20u "$(h00kLanguagePrompt)"
  Pop $1
  ${NSD_CreateRadioButton} 0 32u 100% 21u "English (default)"
  Pop $h00kRadioEn
  ${NSD_CreateRadioButton} 0 62u 100% 21u "Polski"
  Pop $h00kRadioPl
  ${NSD_CreateRadioButton} 0 92u 100% 21u "Русский"
  Pop $h00kRadioRu
  ${NSD_CreateRadioButton} 0 122u 100% 21u "Українська"
  Pop $h00kRadioUk
  ${If} $LANGUAGE == 1045
    ${NSD_Check} $h00kRadioPl
  ${ElseIf} $LANGUAGE == 1049
    ${NSD_Check} $h00kRadioRu
  ${ElseIf} $LANGUAGE == 1058
    ${NSD_Check} $h00kRadioUk
  ${Else}
    ${NSD_Check} $h00kRadioEn
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function h00kLanguagePageLeave
  ${NSD_GetState} $h00kRadioEn $R0
  ${If} $R0 == ${BST_CHECKED}
    StrCpy $LANGUAGE 1033
  ${EndIf}
  ${NSD_GetState} $h00kRadioPl $R0
  ${If} $R0 == ${BST_CHECKED}
    StrCpy $LANGUAGE 1045
  ${EndIf}
  ${NSD_GetState} $h00kRadioRu $R0
  ${If} $R0 == ${BST_CHECKED}
    StrCpy $LANGUAGE 1049
  ${EndIf}
  ${NSD_GetState} $h00kRadioUk $R0
  ${If} $R0 == ${BST_CHECKED}
    StrCpy $LANGUAGE 1058
  ${EndIf}
FunctionEnd

Function h00kShortcutPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(h00kShortcutTitle)" "$(h00kShortcutSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 12u 100% 45u "$(h00kShortcutPrompt)"
  Pop $1
  ${NSD_CreateCheckbox} 0 83u 100% 25u "$(h00kShortcutOption)"
  Pop $h00kShortcutCheck
  ${If} $h00kShortcutWanted == "1"
    ${NSD_Check} $h00kShortcutCheck
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function h00kShortcutPageLeave
  ${NSD_GetState} $h00kShortcutCheck $h00kShortcutWanted
FunctionEnd

Function h00kGuideBasicsCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(h00kGuideTitle)" "$(h00kGuideSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 5u 100% 35u "$(h00kGuide1)"
  Pop $1
  ${NSD_CreateLabel} 0 58u 100% 35u "$(h00kGuide2)"
  Pop $1
  ${NSD_CreateLabel} 0 108u 100% 66u "$(h00kGuide3)"
  Pop $1
  nsDialogs::Show
FunctionEnd

Function h00kGuideLayoutCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(h00kLayoutTitle)" "$(h00kLayoutSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 3u 100% 36u "$(h00kGuide4)"
  Pop $1
  ${NSD_CreateLabel} 0 47u 100% 58u "$(h00kGuide5)"
  Pop $1
  ${NSD_CreateLabel} 0 114u 100% 36u "$(h00kApi1)"
  Pop $1
  ${NSD_CreateLabel} 0 157u 100% 45u "$(h00kApi2)"
  Pop $1
  nsDialogs::Show
FunctionEnd

Function h00kGuideApiCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(h00kApiTitle)" "$(h00kApiSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 1u 100% 45u "$(h00kApi3)"
  Pop $1
  ${NSD_CreateLabel} 0 57u 100% 65u "$(h00kApi4)"
  Pop $1
  ${NSD_CreateLabel} 0 133u 100% 52u "$(h00kApi5)"
  Pop $1
  ${NSD_CreateLabel} 0 192u 100% 19u "$(h00kGuideFooter)"
  Pop $1
  nsDialogs::Show
FunctionEnd

!endif ; BUILD_UNINSTALLER

!macro customInstall
  ${If} $h00kShortcutWanted != "1"
    Delete "$newDesktopLink"
    Delete "$oldDesktopLink"
  ${Else}
    ${IfNot} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  ${EndIf}
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "H00kDesktopShortcutChoice" "$h00kShortcutWanted"
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "H00kInstallerLanguage" "$LANGUAGE"
!macroend
