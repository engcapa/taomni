//! WGC retains only the newest native surface; CPU readback is consumer-paced.
//! SystemRelativeTime supplies the sampling instant, not callback receipt time.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use scopeguard::guard;
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONULL, MonitorFromPoint};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::core::{IInspectable, Interface, factory};

use super::Frame;

struct NativeFrame(Direct3D11CaptureFrame);

impl Drop for NativeFrame {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}

struct Slot<T> {
    state: Mutex<SlotState<T>>,
    ready: Condvar,
}

struct SlotState<T> {
    latest: Option<T>,
    stopped: bool,
    error: Option<String>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(SlotState {
                latest: None,
                stopped: false,
                error: None,
            }),
            ready: Condvar::new(),
        }
    }
}

impl<T> Slot<T> {
    fn publish(&self, frame: T) {
        let mut old = Some(frame);
        if let Ok(mut state) = self.state.lock() {
            if !state.stopped {
                old = std::mem::replace(&mut state.latest, old);
                self.ready.notify_one();
            }
        }
        // Closing an obsolete native surface happens outside the lock.
        drop(old);
    }

    fn fail(&self, error: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.error = Some(error.into());
        }
        self.ready.notify_all();
    }

    fn stop(&self) {
        let frame = self.state.lock().ok().and_then(|mut state| {
            state.stopped = true;
            state.latest.take()
        });
        drop(frame);
        self.ready.notify_all();
    }

    fn take(&self, timeout: Duration) -> anyhow::Result<Option<T>> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("WGC mailbox poisoned"))?;
        loop {
            if state.stopped {
                anyhow::bail!("WGC capture stopped");
            }
            if let Some(error) = state.error.take() {
                anyhow::bail!("WGC callback failed: {error}");
            }
            if let Some(frame) = state.latest.take() {
                return Ok(Some(frame));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            (state, _) = self
                .ready
                .wait_timeout(state, deadline - now)
                .map_err(|_| anyhow::anyhow!("WGC mailbox poisoned"))?;
        }
    }
}

pub(super) struct WgcStream {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    token: i64,
    slot: Arc<Slot<NativeFrame>>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    staging: Option<ID3D11Texture2D>,
    dimensions: (u32, u32),
}

impl WgcStream {
    pub(super) fn start(monitor: &xcap::Monitor) -> anyhow::Result<Self> {
        let point = POINT {
            x: monitor.x()? + (monitor.width()? / 2) as i32,
            y: monitor.y()? + (monitor.height()? / 2) as i32,
        };
        let handle = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONULL) };
        if handle.is_invalid() {
            anyhow::bail!("WGC monitor is unavailable");
        }
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(handle)? };
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
        }
        let device = device.context("WGC D3D11 device missing")?;
        let context = context.context("WGC D3D11 context missing")?;
        let dxgi = device.cast::<IDXGIDevice>()?;
        let native_device: IDirect3DDevice =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
        let size = item.Size()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &native_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let slot = Arc::new(Slot::default());
        let target = slot.clone();
        let subscription = pool.FrameArrived(&TypedEventHandler::<
            Direct3D11CaptureFramePool,
            IInspectable,
        >::new(move |sender, _| {
            if let Some(pool) = sender.as_ref() {
                match pool.TryGetNextFrame() {
                    Ok(frame) => target.publish(NativeFrame(frame)),
                    Err(error) => target.fail(error.to_string()),
                }
            }
            Ok(())
        }));
        let token = match subscription {
            Ok(token) => token,
            Err(error) => {
                let _ = pool.Close();
                return Err(error.into());
            }
        };
        let session = match pool.CreateCaptureSession(&item) {
            Ok(session) => session,
            Err(error) => {
                let _ = pool.RemoveFrameArrived(token);
                let _ = pool.Close();
                return Err(error.into());
            }
        };
        let _ = session.SetIsCursorCaptureEnabled(false);
        let _ = session.SetIsBorderRequired(false);
        let stream = Self {
            pool,
            session,
            token,
            slot,
            device,
            context,
            staging: None,
            dimensions: (0, 0),
        };
        stream.session.StartCapture()?;
        Ok(stream)
    }

    pub(super) fn next(&mut self, timeout: Duration) -> anyhow::Result<Option<Frame>> {
        let Some(frame) = self.slot.take(timeout)? else {
            return Ok(None);
        };
        let native = frame;
        let frame = &native.0;
        let sample_100ns = frame.SystemRelativeTime()?.Duration;
        let mut counter = 0;
        let mut frequency = 0;
        unsafe {
            QueryPerformanceCounter(&mut counter)?;
            QueryPerformanceFrequency(&mut frequency)?;
        }
        let captured_at = sample_instant(Instant::now(), counter, frequency, sample_100ns)?;
        let access = frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?;
        let texture = unsafe { access.GetInterface::<ID3D11Texture2D>()? };
        let size = frame.ContentSize()?;
        let width = u16::try_from(size.Width).context("WGC width exceeds limits")?;
        let height = u16::try_from(size.Height).context("WGC height exceeds limits")?;
        if width == 0 || height == 0 {
            anyhow::bail!("WGC empty frame");
        }
        let row_bytes = usize::from(width) * 4;
        let bytes = row_bytes
            .checked_mul(usize::from(height))
            .context("WGC frame size overflow")?;
        if bytes > 512 * 1024 * 1024 {
            anyhow::bail!("WGC frame exceeds memory budget");
        }
        let dimensions = (u32::from(width), u32::from(height));
        let mut descriptor = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            texture.GetDesc(&mut descriptor);
        }
        if (descriptor.Width, descriptor.Height) != dimensions {
            anyhow::bail!("WGC surface geometry changed");
        }
        if self.dimensions != dimensions || self.staging.is_none() {
            descriptor.BindFlags = 0;
            descriptor.MiscFlags = 0;
            descriptor.Usage = D3D11_USAGE_STAGING;
            descriptor.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            let mut staging = None;
            unsafe {
                self.device
                    .CreateTexture2D(&descriptor, None, Some(&mut staging))?;
            }
            self.staging = Some(staging.context("WGC staging texture missing")?);
            self.dimensions = dimensions;
        }
        let staging = self.staging.as_ref().unwrap().cast::<ID3D11Resource>()?;
        let source = texture.cast::<ID3D11Resource>()?;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context.CopyResource(&staging, &source);
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }
        let _unmap = guard((), |_| unsafe {
            self.context.Unmap(&staging, 0);
        });
        if mapped.pData.is_null() || (mapped.RowPitch as usize) < row_bytes {
            anyhow::bail!("WGC invalid mapped surface");
        }
        let mut bgra = vec![0u8; bytes];
        for (row, out) in bgra.chunks_exact_mut(row_bytes).enumerate() {
            let input = unsafe {
                std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                    row_bytes,
                )
            };
            out.copy_from_slice(input);
        }
        let mut result = Frame::bgra(bgra, 0, 0, width, height, row_bytes);
        result.captured_at = captured_at;
        Ok(Some(result))
    }
}

impl Drop for WgcStream {
    fn drop(&mut self) {
        self.slot.stop();
        let _ = self.pool.RemoveFrameArrived(self.token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

fn sample_instant(
    now: Instant,
    counter: i64,
    frequency: i64,
    sample_100ns: i64,
) -> anyhow::Result<Instant> {
    if frequency <= 0 || counter < 0 || sample_100ns < 0 {
        anyhow::bail!("WGC invalid performance timestamp");
    }
    let now_100ns = i128::from(counter) * 10_000_000 / i128::from(frequency);
    let age = (now_100ns - i128::from(sample_100ns)).max(0) as u128;
    let nanos = age
        .checked_mul(100)
        .and_then(|n| u64::try_from(n).ok())
        .context("WGC frame age overflow")?;
    now.checked_sub(Duration::from_nanos(nanos))
        .context("WGC sampling instant out of range")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_mailbox_discards_obsolete_surfaces_and_rejects_after_stop() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Surface(u32, Arc<AtomicUsize>);
        impl Drop for Surface {
            fn drop(&mut self) {
                self.1.fetch_add(1, Ordering::SeqCst);
            }
        }
        let closed = Arc::new(AtomicUsize::new(0));
        let slot = Slot::default();
        slot.publish(Surface(1, closed.clone()));
        slot.publish(Surface(2, closed.clone()));
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        let latest = slot.take(Duration::ZERO).unwrap().unwrap();
        assert_eq!(latest.0, 2);
        drop(latest);
        assert!(slot.take(Duration::ZERO).unwrap().is_none());
        slot.publish(Surface(3, closed.clone()));
        slot.stop();
        slot.publish(Surface(4, closed.clone()));
        assert_eq!(closed.load(Ordering::SeqCst), 4);
        assert!(slot.take(Duration::ZERO).is_err());
    }

    #[test]
    fn native_mailbox_stop_wakes_idle_consumer() {
        let slot = Arc::new(Slot::<u32>::default());
        let target = slot.clone();
        let consumer = std::thread::spawn(move || target.take(Duration::from_secs(5)));
        slot.stop();
        assert!(consumer.join().unwrap().is_err());
    }

    #[test]
    fn native_sample_time_does_not_include_readback_delay() {
        let now = Instant::now();
        let sample = sample_instant(now, 10_000_000, 1_000_000, 96_000_000).unwrap();
        assert_eq!(now.duration_since(sample), Duration::from_millis(400));
        assert!(sample_instant(now, 0, 0, 1).is_err());
    }
}
