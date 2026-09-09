; MediaWatcher's installer, when MediaWatcher is already installed.
;
; Running it again used to reinstall without comment, which is the wrong answer
; to every reason someone would deliberately run an installer they already ran:
; they want the new version, they want the current one put back, or they want it
; gone. So it says what it found and asks.
;
; Two things must never see this page. An update the app performs itself has
; already been agreed to — electron-updater passes --updated — and a silent run
; has nobody to ask. Both fall through to the normal install, as does anything
; unexpected: every check below fails by skipping the page, because an installer
; that will not install is far worse than one that does not offer a choice.
;
; Everything that reads a ${define} lives inside the macro rather than out here.
; This file is prepended to the generated script, ahead of the includes that
; define UNINSTALL_REGISTRY_KEY and VERSION, and NSIS expands a define where it
; parses it — so at this level they are simply unknown. The macro is expanded
; further down, by which point they exist.

!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

Var mwDialog
Var mwUpdateOption
Var mwRepairOption
Var mwUninstallOption
Var mwInstalledVersion
Var mwUninstallCommand

!macro customWelcomePage
  Page custom mwMaintenanceShow mwMaintenanceLeave

  Function mwMaintenanceShow
    ; Nobody to ask.
    ${If} ${Silent}
      Abort
    ${EndIf}

    ; The app updating itself. It asked before it closed; it is not asking twice.
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--updated" $R1
    ${IfNot} ${Errors}
      Abort
    ${EndIf}

    ; Per-user first, because that is how this one installs; per-machine after,
    ; in case an older copy was put there.
    ReadRegStr $mwInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ReadRegStr $mwUninstallCommand HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $mwInstalledVersion == ""
      ReadRegStr $mwInstalledVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
      ReadRegStr $mwUninstallCommand HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${EndIf}

    ; A first installation has nothing to maintain.
    ${If} $mwInstalledVersion == ""
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $mwDialog
    ${If} $mwDialog == error
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "MediaWatcher is already installed" \
      "Version $mwInstalledVersion is on this computer. What would you like to do?"

    ${NSD_CreateRadioButton} 0 8u 100% 12u "Update to version ${VERSION}"
    Pop $mwUpdateOption
    ${NSD_CreateRadioButton} 0 26u 100% 12u "Repair — install version ${VERSION} over the top"
    Pop $mwRepairOption
    ${NSD_CreateRadioButton} 0 44u 100% 12u "Uninstall MediaWatcher"
    Pop $mwUninstallOption

    ${NSD_CreateLabel} 0 70u 100% 32u \
      "Your library, database, watch history and settings are kept whichever you choose. \
Uninstalling removes the application and leaves your data folder where it is."
    Pop $0

    ; Repairing and updating do the same thing to the disk — this installer
    ; always writes a complete copy — so only one of them is ever the true
    ; description, and the other says why it is not on offer.
    ${If} $mwInstalledVersion == "${VERSION}"
      EnableWindow $mwUpdateOption 0
      ${NSD_SetText} $mwUpdateOption "Update — version ${VERSION} is already installed"
      ${NSD_SetState} $mwRepairOption ${BST_CHECKED}
    ${Else}
      ${NSD_SetState} $mwUpdateOption ${BST_CHECKED}
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function mwMaintenanceLeave
    ${NSD_GetState} $mwUninstallOption $0
    ${If} $0 != ${BST_CHECKED}
      Return
    ${EndIf}

    ${If} $mwUninstallCommand == ""
      MessageBox MB_ICONEXCLAMATION \
        "MediaWatcher's uninstaller could not be found. Remove it from Windows Settings instead."
      Abort
    ${EndIf}

    ; Hand over to the uninstaller already on the machine and get out of its way.
    ExecWait '$mwUninstallCommand'
    Quit
  FunctionEnd
!macroend
