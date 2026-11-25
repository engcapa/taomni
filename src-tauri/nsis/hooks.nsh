; The SocksCap host owns the helper and Xray lifecycle. Its runtime is outside
; INSTDIR. The legacy application's updater releases its own active capture.

; Remove native libraries installed by pre-module versions.
!macro RemoveLegacyVoiceRuntime
  Delete "$INSTDIR\sherpa-onnx-c-api.dll"
  Delete "$INSTDIR\sherpa-onnx-cxx-api.dll"
  Delete "$INSTDIR\onnxruntime.dll"
  Delete "$INSTDIR\onnxruntime_providers_shared.dll"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RemoveLegacyVoiceRuntime
  ; The stock Tauri /P /UPDATE /R handler starts the new executable from
  ; this installer. Identify that single launch so it can use Explorer's
  ; current desktop environment even when the old app has a stale PATH.
  ${If} $UpdateMode = 1
    ClearErrors
    ${GetOptions} $CMDLINE "/R" $0
    ${IfNot} ${Errors}
      System::Call 'kernel32::GetCurrentProcessId() i.r0'
      System::Call 'kernel32::SetEnvironmentVariableW(w "TAOMNI_UPDATE_INSTALLER_PID", w r0) i'
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro RemoveLegacyVoiceRuntime
  RMDir "$INSTDIR"
!macroend
