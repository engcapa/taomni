// GPU back-end detection for llama-server sidecar.
//
// Strategy:
// - macOS → always Metal (built into the system; no extra detection)
// - Windows / Linux → try Vulkan via the system loader at runtime; fall back
//   to CPU if no compatible ICD is present.
// - CUDA pack is opt-in (downloaded separately) and lives in a different
//   sidecar binary. Detected here when present so the StatusBar can surface
//   it; runtime selection is the user's choice in §11.6 settings.
//
// When the `vulkan-detect` cargo feature is enabled, we go beyond ICD-file
// presence and ask the loader to enumerate physical devices. That gives the
// real device name, API version, and a hard signal that the driver is
// usable — fixes the false positives where vulkan-1.dll exists but the
// driver itself is broken.

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
        // Prefer the user's pre-downloaded CUDA pack when present (§11.6).
        if let Some(cuda) = detect_cuda_pack() {
            return cuda;
        }
        if let Some(vk) = detect_vulkan() {
            return vk;
        }
        GpuBackend::Cpu
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_vulkan() -> Option<GpuBackend> {
    #[cfg(feature = "vulkan-detect")]
    {
        if let Some(g) = enumerate_via_ash() {
            return Some(g);
        }
    }
    if vulkan_loader_present() {
        return Some(GpuBackend::Vulkan {
            device: "system loader".into(),
            api_version: "1.3+".into(),
        });
    }
    None
}

#[cfg(all(not(target_os = "macos"), feature = "vulkan-detect"))]
fn enumerate_via_ash() -> Option<GpuBackend> {
    use ash::vk;
    // Loading the Vulkan entry point can panic if the platform lacks the
    // loader at all; wrap in catch_unwind so a missing driver never takes
    // the whole app down.
    let result = std::panic::catch_unwind(|| -> Option<GpuBackend> {
        // SAFETY: ash::Entry::load() walks the standard search path (via the
        // loader DLL/SO). The returned Entry is owned and dropped on return.
        let entry = unsafe { ash::Entry::load().ok()? };

        let app_name = std::ffi::CString::new("NewMob").ok()?;
        let app_info = vk::ApplicationInfo::default()
            .application_name(&app_name)
            .api_version(vk::API_VERSION_1_3);
        let create_info = vk::InstanceCreateInfo::default().application_info(&app_info);
        // SAFETY: app_info / create_info live until end-of-scope; ash creates
        // the instance using the loader's process-wide handle.
        let instance = unsafe { entry.create_instance(&create_info, None).ok()? };

        // SAFETY: instance is alive; enumerate_physical_devices is read-only
        // and may return empty when no compatible GPU exists.
        let devices = unsafe { instance.enumerate_physical_devices().ok()? };
        let device = devices.first().copied()?;
        let props = unsafe { instance.get_physical_device_properties(device) };
        let name = props.device_name_as_c_str().ok()
            .and_then(|c| c.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| "Unknown GPU".to_string());

        let major = vk::api_version_major(props.api_version);
        let minor = vk::api_version_minor(props.api_version);
        let patch = vk::api_version_patch(props.api_version);
        let api_version = format!("{major}.{minor}.{patch}");

        unsafe { instance.destroy_instance(None) };
        Some(GpuBackend::Vulkan { device: name, api_version })
    });
    result.ok().flatten()
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

/// Look for the on-demand CUDA pack the user may have downloaded via
/// `cuda_pack_install` (§11.6). When present, this signals to the StatusBar
/// that the user has CUDA available; the sidecar still picks the runtime.
#[cfg(not(target_os = "macos"))]
fn detect_cuda_pack() -> Option<GpuBackend> {
    let cache = dirs::cache_dir()?;
    let cuda_dir = cache.join("newmob").join("sidecar-cuda");
    if !cuda_dir.exists() {
        return None;
    }
    // We don't enumerate devices here — that would need linking nvml/cuda.
    // The pack's mere presence implies the user opted in.
    Some(GpuBackend::Cuda {
        device: "Pre-installed CUDA pack".into(),
        driver: "user-provided".into(),
    })
}
