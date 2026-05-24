// Real sherpa-onnx wrapper. Only compiled when `--features asr-sherpa-onnx`
// is supplied. The CI pipeline does not enable this by default — the
// onnxruntime native build adds ~120MB to the resulting binary plus a
// CMake/clang dependency; users build it locally when they want real ASR.
//
// We isolate the unsafe / native-construction code here so the rest of the
// crate can stay pure-Rust and compile on a vanilla toolchain.

#![cfg(feature = "asr-sherpa-onnx")]

use std::path::Path;

/// Decode 16kHz mono f32 PCM into text. Returns Err with a user-facing
/// message on any failure; never panics.
pub fn decode(_model_dir: &Path, _pcm: &[f32]) -> Result<String, String> {
    // The actual sherpa-onnx 1.13 API requires building OnlineRecognizerConfig
    // + OnlineModelConfig + OnlineTransducerModelConfig with paths to the
    // tokens.txt + encoder/decoder/joiner ONNX files in `model_dir`. Wiring
    // this up requires the manifest to publish a triple-bundle and the user
    // to have rebuilt with the feature flag — which is the explicit gate.
    //
    // Returning Err here forces the fallback path in sherpa_onnx.rs to keep
    // working on builds where the feature is enabled but the recognizer
    // hasn't been wired yet (e.g. a vendor crate API change between point
    // releases). This avoids silent wrong outputs.
    Err(
        "sherpa-onnx feature compiled but decode is not yet wired to the recognizer. \
         See src-tauri/src/asr/sherpa_onnx_real.rs."
            .into(),
    )
}
