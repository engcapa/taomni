//! A killable helper process, not a detached native capture thread.

use super::super::*;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Sample {
    pub index: usize,
    pub capture_started_ms: f64,
    pub capture_ended_ms: f64,
    pub capture_started_mono_ms: f64,
    pub capture_ended_mono_ms: f64,
    pub modal_share: f64,
    pub modal_color: [u8; 3],
    pub width: u32,
    pub height: u32,
    pub transport: String,
}

impl Sample {
    pub fn valid(&self) -> bool {
        [
            self.capture_started_ms,
            self.capture_ended_ms,
            self.capture_started_mono_ms,
            self.capture_ended_mono_ms,
            self.modal_share,
        ]
        .iter()
        .all(|value| value.is_finite())
            && self.capture_started_ms <= self.capture_ended_ms
            && self.capture_started_mono_ms <= self.capture_ended_mono_ms
            && (0.0..=1.0).contains(&self.modal_share)
            && self.width > 0
            && self.height > 0
            && !self.transport.is_empty()
    }
}

pub(super) struct Sampler {
    child: Child,
    output: PathBuf,
    stop: PathBuf,
    log: PathBuf,
}

impl Sampler {
    pub fn start(display: &DisplayInfo) -> anyhow::Result<Self> {
        let relative = ".agents/skills/qa-ui-auto/scripts/screenshot_flash_sampler.py";
        let script = std::env::current_dir()?.join(relative);
        let script = if script.is_file() {
            script
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join(relative)
        };
        anyhow::ensure!(script.is_file(), "independent sampler script missing");
        #[cfg(target_os = "windows")]
        let candidates = ["python", "python3"];
        #[cfg(not(target_os = "windows"))]
        let candidates = ["python3", "python"];
        let python = candidates
            .iter()
            .find_map(|name| which::which(name).ok())
            .context("independent sampler Python unavailable")?;
        std::fs::create_dir_all(artifact_dir())?;
        let output = evidence_path("startup-flash-samples.jsonl");
        let stop = evidence_path("startup-flash.stop");
        let log = evidence_path("startup-flash-helper.log");
        let mut command = Command::new(python);
        command
            .arg("-I")
            .arg(script)
            .arg("--output")
            .arg(&output)
            .arg("--stop")
            .arg(&stop)
            .arg("--rect")
            .arg(
                json!({"x":display.x,"y":display.y,"width":display.width,"height":display.height})
                    .to_string(),
            )
            .arg("--scale")
            .arg(display.scale_factor.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(std::fs::File::create(&log)?));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = command
            .spawn()
            .context("start independent display sampler")?;
        Ok(Self {
            child,
            output,
            stop,
            log,
        })
    }

    pub fn artifacts(&self) -> Value {
        json!({"samples":self.output,"helperLog":self.log,"pid":self.child.id()})
    }

    fn read(&self) -> anyhow::Result<(Vec<Sample>, bool)> {
        let contents = match std::fs::read_to_string(&self.output) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((vec![], false));
            }
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            contents.len() <= 2_000_000,
            "sampler trace exceeded its bound"
        );
        let mut samples = Vec::new();
        let mut stopped = false;
        // An in-progress final line is not evidence yet.
        for line in contents
            .split_inclusive('\n')
            .filter(|line| line.ends_with('\n'))
        {
            let value: Value = serde_json::from_str(line).context("invalid sampler JSONL")?;
            match value["kind"].as_str() {
                Some("sample") => {
                    let sample: Sample = serde_json::from_value(value)?;
                    anyhow::ensure!(
                        sample.valid() && sample.index == samples.len(),
                        "invalid sampler frame"
                    );
                    samples.push(sample);
                }
                Some("error") => anyhow::bail!("independent sampler: {}", value["error"]),
                Some("stopped") => stopped = true,
                _ => anyhow::bail!("invalid sampler event"),
            }
        }
        Ok((samples, stopped))
    }

    pub async fn ready(&mut self) -> anyhow::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let (samples, _) = self.read()?;
            if samples.len() >= 2 {
                return Ok(());
            }
            anyhow::ensure!(
                self.child.try_wait()?.is_none(),
                "sampler exited before baseline; see {}",
                self.log.display()
            );
            anyhow::ensure!(
                Instant::now() < deadline,
                "sampler baseline timed out; see {}",
                self.log.display()
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    pub async fn finish(&mut self) -> anyhow::Result<Vec<Sample>> {
        std::fs::write(&self.stop, b"stop")?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = self.child.try_wait()? {
                let (samples, stopped) = self.read()?;
                anyhow::ensure!(
                    status.success() && stopped,
                    "sampler did not stop cleanly: {status}"
                );
                return Ok(samples);
            }
            if Instant::now() >= deadline {
                self.kill();
                anyhow::bail!(
                    "sampler stop timed out; helper killed, see {}",
                    self.log.display()
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn kill(&mut self) {
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        #[cfg(unix)]
        unsafe {
            // Only this helper's dedicated process group, never the QA app's.
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        // Bound reaping even when the native capture API never returns.
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.stop, b"stop");
        self.kill();
        let _ = std::fs::remove_file(&self.stop);
    }
}
