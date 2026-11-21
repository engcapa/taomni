//! Keep a recording's model selection stable across configuration changes.

use std::sync::{Arc, atomic::AtomicBool};

use taomni_local_voice_api::{Mode, ModelSelection};
use tokio_util::sync::CancellationToken;

use crate::{plugin::PluginRegistry, voice::local_host};

pub struct AsrManager {
    selection: ModelSelection,
    #[cfg(any(feature = "asr-whisper", feature = "asr-sherpa"))]
    pub(crate) legacy: taomni_local_voice_engine::AsrManager,
}

pub fn configured(model_id: &str, language: &str) -> AsrManager {
    let models_root = local_host::absolute(crate::models::store::models_root());
    AsrManager {
        #[cfg(any(feature = "asr-whisper", feature = "asr-sherpa"))]
        legacy: taomni_local_voice_engine::AsrManager::configured(
            models_root.clone(),
            model_id,
            language,
        ),
        selection: ModelSelection {
            models_root,
            model_id: model_id.into(),
            language: language.into(),
        },
    }
}

impl AsrManager {
    pub(crate) fn selection(&self) -> &ModelSelection {
        &self.selection
    }

    pub(crate) async fn prepare(
        &self,
        plugins: &Arc<PluginRegistry>,
        stop: &CancellationToken,
    ) -> Result<(), String> {
        if local_host::use_host(plugins)? {
            return local_host::prepare(plugins, &self.selection, stop).await;
        }
        #[cfg(any(feature = "asr-whisper", feature = "asr-sherpa"))]
        return self.legacy.prepare().await;
        #[cfg(not(any(feature = "asr-whisper", feature = "asr-sherpa")))]
        Err("Local Voice module is unavailable".into())
    }

    pub(crate) async fn transcribe(
        &self,
        plugins: &Arc<PluginRegistry>,
        pcm: Vec<f32>,
        cancel: Arc<AtomicBool>,
        stop: &CancellationToken,
    ) -> Result<String, String> {
        if local_host::use_host(plugins)? {
            let mut text = None;
            local_host::run(
                plugins,
                self.selection.clone(),
                Mode::Decode,
                local_host::Input::Buffer(pcm),
                stop,
                |result| text = Some(result.text),
            )
            .await?;
            return text.ok_or_else(|| "Local Voice returned no transcription".into());
        }
        #[cfg(any(feature = "asr-whisper", feature = "asr-sherpa"))]
        return self.legacy.transcribe(pcm, cancel).await;
        #[cfg(not(any(feature = "asr-whisper", feature = "asr-sherpa")))]
        {
            let _ = cancel;
            Err("Local Voice module is unavailable".into())
        }
    }
}

#[cfg(all(test, feature = "asr-whisper"))]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    /// Run with NEWMOB_CACHE_DIR pointing at an isolated cache containing the
    /// pinned base model, and TAOMNI_VOICE_PCM pointing at 16 kHz mono f32 LE.
    #[cfg(feature = "asr-whisper")]
    #[tokio::test]
    #[ignore = "requires the pinned base weights and official JFK audio fixture"]
    async fn base_decodes_real_audio_and_cancels() {
        let path = std::env::var("TAOMNI_VOICE_PCM").expect("TAOMNI_VOICE_PCM");
        let bytes = std::fs::read(path).unwrap();
        let pcm: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        let engine = configured("whisper-base", "en").legacy;
        let start = std::time::Instant::now();
        let text = engine
            .transcribe(pcm.clone(), Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        eprintln!("Whisper Base: {text}; elapsed {:?}", start.elapsed());
        let lower = text.to_lowercase();
        assert!(
            lower.contains("ask not") && lower.contains("country"),
            "{text}"
        );
        assert_eq!(
            engine
                .transcribe(pcm.clone(), Arc::new(AtomicBool::new(true)))
                .await
                .unwrap_err(),
            "Cancelled"
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let cancellation = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            signal.store(true, Ordering::Relaxed);
        });
        assert_eq!(
            engine.transcribe(pcm.clone(), cancel).await.unwrap_err(),
            "Cancelled"
        );
        cancellation.await.unwrap();
        // A cancelled decode must not poison the reused recognizer or abort
        // the next recording; also catches invalid native callback user-data.
        let retry = engine
            .transcribe(pcm, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert!(retry.to_lowercase().contains("country"), "{retry}");
    }
    #[cfg(feature = "asr-whisper")]
    #[tokio::test]
    #[ignore = "requires the pinned multilingual base model and Chinese audio fixture"]
    async fn base_decodes_chinese_audio() {
        let bytes =
            std::fs::read(std::env::var("TAOMNI_VOICE_ZH_PCM").expect("TAOMNI_VOICE_ZH_PCM"))
                .unwrap();
        let pcm = bytes
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        let engine = configured("whisper-base", "zh").legacy;
        let start = std::time::Instant::now();
        let text = engine
            .transcribe(pcm, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        eprintln!(
            "Whisper Base Chinese: {text}; elapsed {:?}",
            start.elapsed()
        );
        // Independent FLEURS ground truth. Normalize punctuation and the
        // traditional variants in this sentence before measuring character errors.
        let actual: Vec<char> = text
            .chars()
            .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
            .map(|c| match c {
                '這' => '这',
                '並' => '并',
                '別' => '别',
                '個' => '个',
                '結' => '结',
                '開' => '开',
                c => c,
            })
            .collect();
        let reference: Vec<char> = "这并不是告别这是一个篇章的结束也是新篇章的开始"
            .chars()
            .collect();
        let mut previous: Vec<usize> = (0..=reference.len()).collect();
        for (i, a) in actual.iter().enumerate() {
            let mut next = vec![i + 1; reference.len() + 1];
            for (j, b) in reference.iter().enumerate() {
                next[j + 1] = (previous[j] + usize::from(a != b))
                    .min(previous[j + 1] + 1)
                    .min(next[j] + 1);
            }
            previous = next;
        }
        let cer = previous[reference.len()] as f64 / reference.len() as f64;
        eprintln!("Chinese fixture character error rate: {cer:.3}");
        assert!(cer <= 0.25, "Chinese fixture CER {cer:.3}: {text}");
    }
}
