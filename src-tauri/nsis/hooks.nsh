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
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro RemoveLegacyVoiceRuntime
  RMDir "$INSTDIR"
!macroend
