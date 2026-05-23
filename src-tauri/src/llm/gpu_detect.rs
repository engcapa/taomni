// GPU back-end detection for llama-server sidecar.
//
// Strategy:
// - macOS → always Metal (built into the system; no extra detection)
// - Windows / Linux → try Vulkan via the system loader at runtime; fall back
//   to CPU if no compatible ICD is present.
// - CUDA pack is opt-in (downloaded separately) and lives in a different
//   sidecar binary. Not detected here.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GpuBackend {
    Cpu,
    Metal,
    Vulkan { device: String, api_version: String },
    Cuda { device: String, driver: String },
}

impl GpuBackend {
    pub fn label(&self) -> String {
        match self {
            Self::Cpu => "CPU".to_string(),
            Self::Metal => "Metal".to_string(),
            Self::Vulkan { device, .. } => format!("Vulkan ({device})"),
            Self::Cuda { device, .. } => format!("CUDA ({device})"),
        }
    }
}

/// Detect the best available GPU back-end. Always succeeds; falls back to CPU.
pub fn detect() -> GpuBackend {
    #[cfg(target_os = "macos")]
    {
        return GpuBackend::Metal;
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Without an `ash` (Vulkan) dep, we do a lightweight loader probe by
        // checking whether the platform's Vulkan runtime DLL/SO is present.
        // A real Vulkan device check needs `ash` — added in the v2.x ggml
        // shared-build spike. For now this gives the StatusBar accurate
        // "Vulkan available" hints; the sidecar still negotiates with the
        // driver at startup.
        if vulkan_loader_present() {
            return GpuBackend::Vulkan {
                device: "system loader".into(),
                api_version: "1.3+".into(),
            };
        }
        GpuBackend::Cpu
    }
}

#[cfg(target_os = "windows")]
fn vulkan_loader_present() -> bool {
    // vulkan-1.dll ships with the GPU driver; presence in System32 is
    // a strong signal that at least one ICD is installed.
    let candidates = [r"C:\Windows\System32\vulkan-1.dll"];
    candidates.iter().any(|p| std::path::Path::new(p).exists())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn vulkan_loader_present() -> bool {
    let candidates = [
        "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
        "/usr/lib64/libvulkan.so.1",
        "/usr/lib/libvulkan.so.1",
    ];
    candidates.iter().any(|p| std::path::Path::new(p).exists())
}
