//! Headless Sockscap core performance and lifecycle-soak gate.
//!
//! This binary deliberately uses a synthetic adapter: it exercises the real
//! policy matcher, bounded dashboard sampler, durable recovery journal, and
//! capture transaction coordinator without changing host routes, firewall
//! rules, interfaces, or process cgroups. Its receipt is therefore useful CI
//! evidence, but is never sufficient platform-capture release evidence.

use std::env;
use std::hint::black_box;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, get_current_pid};
use taomni_lib::sockscap::capture::coordinator::CaptureTransactionCoordinator;
use taomni_lib::sockscap::capture::{
    AdapterProbe, CaptureAdapter, CaptureArtifactState, CaptureError, CaptureHandle,
    CaptureInstallSpec, CaptureMode,
};
use taomni_lib::sockscap::flow::stats::{
    FlowOutcomeKind, FlowStatsEvent, FlowStatsSink, LiveConnectionsQuery, LiveFlowSampler,
};
use taomni_lib::sockscap::policy::{CompiledRule, FlowMatchInput, ProfileMatcher, RuleKind};
use taomni_lib::sockscap::storage::{RecoveryPhase, SockscapStore};
use taomni_lib::sockscap::types::{CapturePlatform, HostnameSource, RouteAction};

const SCHEMA_VERSION: u32 = 1;
const RULE_COUNT: usize = 10_000;
const RULE_WARMUP_SAMPLES: usize = 2_000;
const RULE_MATCH_SAMPLES: usize = 20_000;
const RULE_P99_THRESHOLD_NANOS: u64 = 100_000;
const START_STOP_CYCLES: u64 = 100;
const DASHBOARD_EVENT_COUNT: u64 = 1_000;
const MAX_RSS_END_GROWTH_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RSS_PEAK_GROWTH_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OPEN_FILE_GROWTH: u64 = 4;
const RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const SOAK_TICK: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateMode {
    Quick,
    Soak,
}

impl GateMode {
    fn name(self) -> &'static str {
        match self {
            Self::Quick => "quick",
            Self::Soak => "soak",
        }
    }
}

struct Args {
    mode: GateMode,
    duration_seconds: Option<u64>,
    output: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GateReceipt {
    schema_version: u32,
    gate_kind: &'static str,
    evidence_class: &'static str,
    release_eligible: bool,
    mode: &'static str,
    passed: bool,
    optimized_build: bool,
    platform: &'static str,
    architecture: &'static str,
    git_commit: Option<String>,
    started_at_unix: u64,
    finished_at_unix: u64,
    observed_duration_millis: u64,
    requested_soak_duration_seconds: Option<u64>,
    rule_match: RuleMatchGate,
    dashboard: DashboardGate,
    lifecycle: LifecycleGate,
    resources: ResourceGate,
    limitations: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleMatchGate {
    rule_count: usize,
    sample_count: usize,
    compile_millis: u64,
    median_nanos: u64,
    p99_nanos: u64,
    p99_threshold_nanos: u64,
    matched_all_samples: bool,
    passed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardGate {
    generated_events: u64,
    retained_capacity: u16,
    returned_samples: usize,
    dropped_samples: u64,
    query_p99_nanos: u64,
    bounded: bool,
    passed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleGate {
    required_start_stop_cycles: u64,
    completed_start_stop_cycles: u64,
    long_active_session_completed: bool,
    heartbeat_count: u64,
    cycle_median_nanos: u64,
    cycle_p99_nanos: u64,
    final_journal_phase: String,
    cleanup_required: bool,
    adapter_install_calls: u64,
    adapter_stop_calls: u64,
    adapter_recover_calls: u64,
    passed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceGate {
    sample_count: u64,
    rss_start_bytes: u64,
    rss_end_bytes: u64,
    rss_peak_bytes: u64,
    rss_end_growth_bytes: i64,
    rss_peak_growth_bytes: u64,
    max_rss_end_growth_bytes: u64,
    max_rss_peak_growth_bytes: u64,
    open_file_measurement_supported: bool,
    open_files_start: Option<u64>,
    open_files_end: Option<u64>,
    open_files_peak: Option<u64>,
    open_file_growth: Option<i64>,
    max_open_file_growth: u64,
    passed: bool,
}

#[derive(Default)]
struct GateAdapter {
    installs: AtomicU64,
    updates: AtomicU64,
    stops: AtomicU64,
    recovers: AtomicU64,
    heartbeats: AtomicU64,
}

impl GateAdapter {
    fn artifact(generation: u64) -> CaptureArtifactState {
        CaptureArtifactState {
            adapter: "synthetic_gate".into(),
            generation,
            owner_uid: None,
            interface_names: vec![format!("synthetic-{generation}")],
            rule_ids: vec![format!("synthetic-rule-{generation}")],
            route_ids: Vec::new(),
            cgroup_paths: Vec::new(),
            driver_service: None,
            extension_bundle_id: None,
            process_restores: Vec::new(),
        }
    }
}

#[async_trait]
impl CaptureAdapter for GateAdapter {
    fn id(&self) -> &'static str {
        "synthetic_gate"
    }

    fn platform(&self) -> CapturePlatform {
        CapturePlatform::current()
    }

    async fn probe(&self) -> AdapterProbe {
        AdapterProbe {
            adapter: self.id().into(),
            platform: self.platform(),
            installed: true,
            privileged_helper_ready: false,
            signature_verified: false,
            global_available: false,
            application_group_available: false,
            runtime_pid_available: false,
            detail: "Synthetic gate adapter; never installs host capture state".into(),
        }
    }

    async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError> {
        self.installs.fetch_add(1, Ordering::Relaxed);
        Ok(CaptureHandle {
            generation: spec.generation,
            config_revision: spec.config_revision,
            helper_pid: process::id(),
            artifact: Self::artifact(spec.generation),
        })
    }

    async fn update(
        &self,
        handle: &CaptureHandle,
        _spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError> {
        self.updates.fetch_add(1, Ordering::Relaxed);
        Ok(handle.clone())
    }

    async fn stop(&self, _handle: &CaptureHandle) -> Result<(), CaptureError> {
        self.stops.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    async fn recover(&self, _artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
        self.recovers.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError> {
        self.heartbeats.fetch_add(1, Ordering::Relaxed);
        Ok(handle.clone())
    }
}

struct ProcessSampler {
    system: System,
    pid: sysinfo::Pid,
    samples: u64,
    rss_start: Option<u64>,
    rss_end: Option<u64>,
    rss_peak: u64,
    files_start: Option<u64>,
    files_end: Option<u64>,
    files_peak: Option<u64>,
}

impl ProcessSampler {
    fn new() -> Result<Self, String> {
        Ok(Self {
            system: System::new(),
            pid: get_current_pid().map_err(str::to_string)?,
            samples: 0,
            rss_start: None,
            rss_end: None,
            rss_peak: 0,
            files_start: None,
            files_end: None,
            files_peak: None,
        })
    }

    fn sample(&mut self) -> Result<(), String> {
        let pids = [self.pid];
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        let process = self
            .system
            .process(self.pid)
            .ok_or_else(|| "current process disappeared from resource sampler".to_string())?;
        let rss = process.memory();
        let files = process
            .open_files()
            .and_then(|value| u64::try_from(value).ok());

        self.samples += 1;
        self.rss_start.get_or_insert(rss);
        self.rss_end = Some(rss);
        self.rss_peak = self.rss_peak.max(rss);
        if self.samples == 1 {
            self.files_start = files;
        }
        self.files_end = files;
        self.files_peak = match (self.files_peak, files) {
            (Some(current), Some(next)) => Some(current.max(next)),
            (None, Some(next)) => Some(next),
            (current, None) => current,
        };
        Ok(())
    }

    fn finish(mut self) -> Result<ResourceGate, String> {
        self.sample()?;
        let rss_start = self
            .rss_start
            .ok_or_else(|| "resource sampler did not record RSS".to_string())?;
        let rss_end = self
            .rss_end
            .ok_or_else(|| "resource sampler did not finish RSS".to_string())?;
        let rss_end_growth = signed_delta(rss_end, rss_start);
        let rss_peak_growth = self.rss_peak.saturating_sub(rss_start);
        let open_file_measurement_supported =
            self.files_start.is_some() && self.files_end.is_some();
        let open_file_growth = self
            .files_start
            .zip(self.files_end)
            .map(|(start, end)| signed_delta(end, start));
        let rss_passed = positive_delta(rss_end_growth) <= MAX_RSS_END_GROWTH_BYTES
            && rss_peak_growth <= MAX_RSS_PEAK_GROWTH_BYTES;
        let files_passed = open_file_growth
            .map(|growth| positive_delta(growth) <= MAX_OPEN_FILE_GROWTH)
            .unwrap_or(true);
        Ok(ResourceGate {
            sample_count: self.samples,
            rss_start_bytes: rss_start,
            rss_end_bytes: rss_end,
            rss_peak_bytes: self.rss_peak,
            rss_end_growth_bytes: rss_end_growth,
            rss_peak_growth_bytes: rss_peak_growth,
            max_rss_end_growth_bytes: MAX_RSS_END_GROWTH_BYTES,
            max_rss_peak_growth_bytes: MAX_RSS_PEAK_GROWTH_BYTES,
            open_file_measurement_supported,
            open_files_start: self.files_start,
            open_files_end: self.files_end,
            open_files_peak: self.files_peak,
            open_file_growth,
            max_open_file_growth: MAX_OPEN_FILE_GROWTH,
            passed: rss_passed && files_passed,
        })
    }
}

struct GateWorkspace {
    path: PathBuf,
}

impl GateWorkspace {
    fn create() -> Result<Self, String> {
        let nonce = unix_nanos();
        let path = env::temp_dir().join(format!("taomni-sockscap-gate-{}-{nonce}", process::id()));
        std::fs::create_dir(&path)
            .map_err(|error| format!("create gate workspace {}: {error}", path.display()))?;
        Ok(Self { path })
    }
}

impl Drop for GateWorkspace {
    fn drop(&mut self) {
        let expected_prefix = format!("taomni-sockscap-gate-{}-", process::id());
        let safe = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&expected_prefix))
            && self.path.parent() == Some(env::temp_dir().as_path());
        if safe {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            eprintln!("SOCKSCAP_GATE_ARGUMENT_ERROR: {error}");
            print_usage();
            process::exit(2);
        }
    };

    let receipt = match run_gate(&args).await {
        Ok(receipt) => receipt,
        Err(error) => {
            eprintln!("SOCKSCAP_GATE_ERROR: {error}");
            process::exit(2);
        }
    };
    let json = serde_json::to_string_pretty(&receipt)
        .expect("serializing a fixed Sockscap gate receipt cannot fail");
    println!("{json}");
    if let Some(output) = &args.output
        && let Err(error) = write_receipt(output, &json)
    {
        eprintln!("SOCKSCAP_GATE_RECEIPT_ERROR: {error}");
        process::exit(2);
    }
    if !receipt.passed {
        process::exit(1);
    }
}

async fn run_gate(args: &Args) -> Result<GateReceipt, String> {
    if CapturePlatform::current() == CapturePlatform::Unknown {
        return Err("Sockscap gate supports Windows, macOS, and Linux hosts only".into());
    }
    let started_at_unix = unix_now();
    let started = Instant::now();
    let rule_match = run_rule_match_gate()?;
    let dashboard = run_dashboard_gate()?;
    let (lifecycle, resources) = match args.mode {
        GateMode::Quick => run_quick_lifecycle().await?,
        GateMode::Soak => {
            let duration = Duration::from_secs(
                args.duration_seconds
                    .ok_or_else(|| "soak mode requires --duration-seconds".to_string())?,
            );
            run_soak_lifecycle(duration).await?
        }
    };
    let optimized_build = !cfg!(debug_assertions);
    let passed = optimized_build
        && rule_match.passed
        && dashboard.passed
        && lifecycle.passed
        && resources.passed;
    Ok(GateReceipt {
        schema_version: SCHEMA_VERSION,
        gate_kind: "sockscap_core_performance",
        evidence_class: "synthetic_core_no_host_capture",
        release_eligible: false,
        mode: args.mode.name(),
        passed,
        optimized_build,
        platform: env::consts::OS,
        architecture: env::consts::ARCH,
        git_commit: env::var("GITHUB_SHA")
            .or_else(|_| env::var("SOCKSCAP_GATE_GIT_COMMIT"))
            .ok(),
        started_at_unix,
        finished_at_unix: unix_now(),
        observed_duration_millis: millis(started.elapsed()),
        requested_soak_duration_seconds: args.duration_seconds,
        rule_match,
        dashboard,
        lifecycle,
        resources,
        limitations: vec![
            "synthetic adapter; no host capture state was installed",
            "does not measure TCP connect overhead or captured throughput",
            "does not prove driver/helper signing, macOS entitlement, or notarization",
            "does not replace native packet, DNS, IPv6, VPN, sleep, or cleanup lab evidence",
        ],
    })
}

fn run_rule_match_gate() -> Result<RuleMatchGate, String> {
    let compile_started = Instant::now();
    let matcher = build_matcher();
    let compile_millis = millis(compile_started.elapsed());
    let inputs = build_match_inputs();

    for index in 0..RULE_WARMUP_SAMPLES {
        let decision = matcher.decide(&inputs[index % inputs.len()]);
        black_box(decision);
    }

    let mut samples = Vec::with_capacity(RULE_MATCH_SAMPLES);
    let mut matched_all_samples = true;
    for index in 0..RULE_MATCH_SAMPLES {
        let started = Instant::now();
        let decision = matcher.decide(&inputs[index % inputs.len()]);
        samples.push(nanos(started.elapsed()));
        matched_all_samples &=
            decision.action == RouteAction::Proxy && decision.matched_stage == "subscription_proxy";
        black_box(decision);
    }
    let summary = latency_summary(samples)?;
    let passed = matched_all_samples && summary.p99_nanos < RULE_P99_THRESHOLD_NANOS;
    Ok(RuleMatchGate {
        rule_count: RULE_COUNT,
        sample_count: RULE_MATCH_SAMPLES,
        compile_millis,
        median_nanos: summary.median_nanos,
        p99_nanos: summary.p99_nanos,
        p99_threshold_nanos: RULE_P99_THRESHOLD_NANOS,
        matched_all_samples,
        passed,
    })
}

fn run_dashboard_gate() -> Result<DashboardGate, String> {
    let sampler = LiveFlowSampler::default();
    sampler.set_enabled_profiles(["gate-profile".to_string()]);
    for _ in 0..DASHBOARD_EVENT_COUNT {
        sampler.record(gate_stats_event());
    }
    let query = LiveConnectionsQuery {
        since_unix: None,
        limit: 200,
    };
    let mut query_samples = Vec::with_capacity(1_000);
    let mut snapshot = None;
    for _ in 0..1_000 {
        let started = Instant::now();
        snapshot = Some(sampler.snapshot(&query)?);
        query_samples.push(nanos(started.elapsed()));
    }
    let snapshot = snapshot.ok_or_else(|| "dashboard gate produced no snapshot".to_string())?;
    let query_latency = latency_summary(query_samples)?;
    let bounded = snapshot.capacity == 256
        && snapshot.samples.len() == 200
        && snapshot.dropped_samples == DASHBOARD_EVENT_COUNT - u64::from(snapshot.capacity);
    Ok(DashboardGate {
        generated_events: DASHBOARD_EVENT_COUNT,
        retained_capacity: snapshot.capacity,
        returned_samples: snapshot.samples.len(),
        dropped_samples: snapshot.dropped_samples,
        query_p99_nanos: query_latency.p99_nanos,
        bounded,
        passed: bounded,
    })
}

async fn run_quick_lifecycle() -> Result<(LifecycleGate, ResourceGate), String> {
    let workspace = GateWorkspace::create()?;
    let store = Arc::new(SockscapStore::open(&workspace.path)?);
    let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
    let adapter = GateAdapter::default();

    run_one_cycle(&coordinator, &adapter, 1).await?;
    let mut sampler = ProcessSampler::new()?;
    sampler.sample()?;
    let samples = run_start_stop_cycles(&coordinator, &adapter, START_STOP_CYCLES, 2).await?;
    let resources = sampler.finish()?;
    let journal = store.recovery_journal()?;
    let summary = latency_summary(samples)?;
    let lifecycle = lifecycle_result(&adapter, START_STOP_CYCLES, false, &journal, summary);
    Ok((lifecycle, resources))
}

async fn run_soak_lifecycle(
    requested_duration: Duration,
) -> Result<(LifecycleGate, ResourceGate), String> {
    if requested_duration.is_zero() {
        return Err("soak duration must be at least one second".into());
    }
    let workspace = GateWorkspace::create()?;
    let store = Arc::new(SockscapStore::open(&workspace.path)?);
    let coordinator = CaptureTransactionCoordinator::new(Arc::clone(&store));
    let adapter = GateAdapter::default();

    let cycle_samples = run_start_stop_cycles(&coordinator, &adapter, START_STOP_CYCLES, 1).await?;
    let mut active_spec = capture_spec(START_STOP_CYCLES + 1);
    let mut handle = coordinator
        .install(
            &adapter,
            active_spec.clone(),
            &["gate-profile".into()],
            false,
        )
        .await
        .map_err(|error| error.to_string())?;
    active_spec.generation = handle.generation;

    let matcher = build_matcher();
    let inputs = build_match_inputs();
    let dashboard = LiveFlowSampler::default();
    dashboard.set_enabled_profiles(["gate-profile".to_string()]);
    let mut resources = ProcessSampler::new()?;
    resources.sample()?;
    let active_started = Instant::now();
    let mut last_resource_sample = active_started;
    let mut last_heartbeat = active_started;
    let mut progress_report = active_started;
    let mut iterations = 0_u64;

    while active_started.elapsed() < requested_duration {
        for offset in 0..128_u64 {
            let index = ((iterations + offset) as usize) % inputs.len();
            black_box(matcher.decide(&inputs[index]));
        }
        for _ in 0..16 {
            dashboard.record(gate_stats_event());
        }
        iterations = iterations.saturating_add(128);

        if last_heartbeat.elapsed() >= HEARTBEAT_INTERVAL {
            handle = coordinator
                .heartbeat(&adapter, &handle, &active_spec)
                .await
                .map_err(|error| error.to_string())?;
            last_heartbeat = Instant::now();
        }
        if last_resource_sample.elapsed() >= RESOURCE_SAMPLE_INTERVAL {
            resources.sample()?;
            last_resource_sample = Instant::now();
        }
        if progress_report.elapsed() >= Duration::from_secs(600) {
            eprintln!(
                "SOCKSCAP_GATE_PROGRESS elapsed={}s requested={}s policy_matches={iterations}",
                active_started.elapsed().as_secs(),
                requested_duration.as_secs()
            );
            progress_report = Instant::now();
        }
        tokio::time::sleep(SOAK_TICK).await;
    }

    coordinator
        .stop(&adapter, &handle)
        .await
        .map_err(|error| error.to_string())?;
    let observed_duration = active_started.elapsed();
    let resources = resources.finish()?;
    let dashboard_snapshot = dashboard.snapshot(&LiveConnectionsQuery {
        since_unix: None,
        limit: 200,
    })?;
    if dashboard_snapshot.samples.len() != 200 || dashboard_snapshot.capacity != 256 {
        return Err("bounded dashboard sampler changed shape during soak".into());
    }
    let journal = store.recovery_journal()?;
    let summary = latency_summary(cycle_samples)?;
    let mut lifecycle = lifecycle_result(&adapter, START_STOP_CYCLES, true, &journal, summary);
    lifecycle.passed &= observed_duration >= requested_duration;
    Ok((lifecycle, resources))
}

async fn run_start_stop_cycles(
    coordinator: &CaptureTransactionCoordinator,
    adapter: &GateAdapter,
    cycles: u64,
    first_revision: u64,
) -> Result<Vec<u64>, String> {
    let mut samples = Vec::with_capacity(cycles as usize);
    for cycle in 0..cycles {
        let started = Instant::now();
        run_one_cycle(coordinator, adapter, first_revision + cycle).await?;
        samples.push(nanos(started.elapsed()));
    }
    Ok(samples)
}

async fn run_one_cycle(
    coordinator: &CaptureTransactionCoordinator,
    adapter: &GateAdapter,
    config_revision: u64,
) -> Result<(), String> {
    let handle = coordinator
        .install(
            adapter,
            capture_spec(config_revision),
            &["gate-profile".into()],
            false,
        )
        .await
        .map_err(|error| error.to_string())?;
    let journal = coordinator
        .stop(adapter, &handle)
        .await
        .map_err(|error| error.to_string())?;
    if journal.cleanup_required || journal.phase != RecoveryPhase::Clean {
        return Err(format!(
            "cycle {config_revision} ended with {:?}, cleanup_required={}",
            journal.phase, journal.cleanup_required
        ));
    }
    Ok(())
}

fn lifecycle_result(
    adapter: &GateAdapter,
    completed_cycles: u64,
    long_active_session_completed: bool,
    journal: &taomni_lib::sockscap::storage::RecoveryJournal,
    latency: LatencySummary,
) -> LifecycleGate {
    let installs = adapter.installs.load(Ordering::Relaxed);
    let stops = adapter.stops.load(Ordering::Relaxed);
    let recovers = adapter.recovers.load(Ordering::Relaxed);
    let clean = journal.phase == RecoveryPhase::Clean && !journal.cleanup_required;
    let expected_sessions = completed_cycles + u64::from(long_active_session_completed);
    let passed = completed_cycles >= START_STOP_CYCLES
        && clean
        && installs >= expected_sessions
        && stops >= expected_sessions
        && recovers == 0;
    LifecycleGate {
        required_start_stop_cycles: START_STOP_CYCLES,
        completed_start_stop_cycles: completed_cycles,
        long_active_session_completed,
        heartbeat_count: adapter.heartbeats.load(Ordering::Relaxed),
        cycle_median_nanos: latency.median_nanos,
        cycle_p99_nanos: latency.p99_nanos,
        final_journal_phase: format!("{:?}", journal.phase).to_ascii_lowercase(),
        cleanup_required: journal.cleanup_required,
        adapter_install_calls: installs,
        adapter_stop_calls: stops,
        adapter_recover_calls: recovers,
        passed,
    }
}

fn capture_spec(config_revision: u64) -> CaptureInstallSpec {
    CaptureInstallSpec {
        generation: 0,
        config_revision,
        platform: CapturePlatform::current(),
        mode: CaptureMode::Global,
        gateway: "127.0.0.1:32100"
            .parse()
            .expect("fixed gate address is valid"),
        route_ipv6: true,
        selectors: Vec::new(),
        bypass_ips: vec![IpAddr::from([192, 0, 2, 1])],
        taomni_pid: process::id(),
        helper_pid: None,
    }
}

fn build_matcher() -> ProfileMatcher {
    let rules = (0..RULE_COUNT)
        .map(|index| CompiledRule {
            action: RouteAction::Proxy,
            kind: RuleKind::DomainSuffix,
            pattern: format!("r{index:05}.gate.invalid"),
            original: format!("||r{index:05}.gate.invalid"),
            source_id: "sockscap-gate".into(),
        })
        .collect::<Vec<_>>();
    ProfileMatcher::from_parts(
        "gate-profile",
        RouteAction::Direct,
        RouteAction::Block,
        Vec::new(),
        &[],
        &rules,
    )
}

fn build_match_inputs() -> Vec<FlowMatchInput> {
    (0..RULE_COUNT)
        .map(|index| FlowMatchInput {
            profile_id: "gate-profile".into(),
            hostname: Some(format!("leaf.r{index:05}.gate.invalid")),
            hostname_source: HostnameSource::TlsSni,
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hard_bypass: false,
        })
        .collect()
}

fn gate_stats_event() -> FlowStatsEvent {
    FlowStatsEvent {
        profile_id: "gate-profile".into(),
        protocol: "tcp".into(),
        hostname_source: HostnameSource::TlsSni,
        policy_action: RouteAction::Proxy,
        effective_action: RouteAction::Proxy,
        outcome: FlowOutcomeKind::Established,
        connector: Some("synthetic_gate".into()),
        error_code: None,
        connect_millis: 1,
    }
}

#[derive(Debug, Clone, Copy)]
struct LatencySummary {
    median_nanos: u64,
    p99_nanos: u64,
}

fn latency_summary(mut samples: Vec<u64>) -> Result<LatencySummary, String> {
    if samples.is_empty() {
        return Err("latency sample set is empty".into());
    }
    samples.sort_unstable();
    let median_index = (samples.len() - 1) / 2;
    let p99_rank = samples.len().saturating_mul(99).div_ceil(100);
    let p99_index = p99_rank.saturating_sub(1).min(samples.len() - 1);
    Ok(LatencySummary {
        median_nanos: samples[median_index],
        p99_nanos: samples[p99_index],
    })
}

fn parse_args() -> Result<Args, String> {
    let mut args = env::args().skip(1);
    let mode = match args.next().as_deref() {
        Some("quick") => GateMode::Quick,
        Some("soak") => GateMode::Soak,
        Some(value) => return Err(format!("unknown mode '{value}'")),
        None => return Err("missing mode".into()),
    };
    let mut duration_seconds = None;
    let mut output = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--duration-seconds" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--duration-seconds requires a value".to_string())?;
                let parsed = value
                    .parse::<u64>()
                    .map_err(|_| "--duration-seconds must be an integer".to_string())?;
                if parsed == 0 {
                    return Err("--duration-seconds must be at least 1".into());
                }
                duration_seconds = Some(parsed);
            }
            "--output" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--output requires a path".to_string())?;
                output = Some(PathBuf::from(value));
            }
            value => return Err(format!("unknown argument '{value}'")),
        }
    }
    match (mode, duration_seconds) {
        (GateMode::Quick, Some(_)) => {
            return Err("quick mode does not accept --duration-seconds".into());
        }
        (GateMode::Soak, None) => {
            return Err("soak mode requires --duration-seconds".into());
        }
        _ => {}
    }
    Ok(Args {
        mode,
        duration_seconds,
        output,
    })
}

fn write_receipt(path: &Path, json: &str) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create receipt directory {}: {error}", parent.display()))?;
    std::fs::write(path, format!("{json}\n"))
        .map_err(|error| format!("write receipt {}: {error}", path.display()))
}

fn print_usage() {
    eprintln!(
        "usage:\n  sockscap-gate quick [--output PATH]\n  sockscap-gate soak --duration-seconds N [--output PATH]"
    );
}

fn signed_delta(end: u64, start: u64) -> i64 {
    if end >= start {
        i64::try_from(end - start).unwrap_or(i64::MAX)
    } else {
        -i64::try_from(start - end).unwrap_or(i64::MAX)
    }
}

fn positive_delta(delta: i64) -> u64 {
    u64::try_from(delta.max(0)).unwrap_or(u64::MAX)
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}
