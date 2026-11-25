//! Scenario implementations. Each returns a JSON report; failures keep the
//! partial observations so a red run still carries its raw evidence.

mod dispatch;

mod throughput;

mod readiness;

mod latency;

#[cfg(test)]
mod throughput_comparison_tests;

mod clipboard_send;

mod clipboard_receive;

mod audio;

mod autodetection;

mod images;

pub(crate) use dispatch::run;

pub(crate) use audio::write_wav;
