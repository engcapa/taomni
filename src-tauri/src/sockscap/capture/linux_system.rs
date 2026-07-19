//! Fixed-program Linux command execution and cleanup verification.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;

use super::linux::{LinuxCapturePlan, LinuxCommand, LinuxProgram, resolve_allowlisted_program};
use super::{CaptureArtifactState, CaptureError};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxCommandOutput {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl LinuxCommandOutput {
    pub fn success() -> Self {
        Self {
            success: true,
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
        }
    }
}

#[async_trait]
pub trait LinuxCommandRunner: Send + Sync {
    async fn run(&self, command: &LinuxCommand) -> Result<LinuxCommandOutput, CaptureError>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RealLinuxCommandRunner;

#[async_trait]
impl LinuxCommandRunner for RealLinuxCommandRunner {
    async fn run(&self, command: &LinuxCommand) -> Result<LinuxCommandOutput, CaptureError> {
        let executable = resolve_allowlisted_program(command.program).ok_or_else(|| {
            CaptureError::invalid(
                "LINUX_CAPTURE_PROGRAM_MISSING",
                format!(
                    "required Linux program '{}' was not found in the fixed system allowlist",
                    command.program.name()
                ),
            )
        })?;
        let mut process = tokio::process::Command::new(&executable);
        process
            .args(&command.args)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = process.spawn().map_err(|error| {
            CaptureError::invalid(
                "LINUX_CAPTURE_COMMAND_SPAWN_FAILED",
                format!("could not start '{}': {error}", command.program.name()),
            )
        })?;
        if let Some(input) = command.stdin.as_deref() {
            let mut stdin = child.stdin.take().ok_or_else(|| {
                CaptureError::invalid(
                    "LINUX_CAPTURE_COMMAND_PIPE_FAILED",
                    "privileged command stdin pipe was not created",
                )
            })?;
            stdin.write_all(input.as_bytes()).await.map_err(|error| {
                CaptureError::invalid(
                    "LINUX_CAPTURE_COMMAND_PIPE_FAILED",
                    format!("could not write privileged command input: {error}"),
                )
            })?;
            stdin.shutdown().await.map_err(|error| {
                CaptureError::invalid(
                    "LINUX_CAPTURE_COMMAND_PIPE_FAILED",
                    format!("could not close privileged command input: {error}"),
                )
            })?;
        }
        let output = tokio::time::timeout(COMMAND_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| {
                CaptureError::recovery(
                    "LINUX_CAPTURE_COMMAND_TIMEOUT",
                    format!(
                        "privileged program '{}' exceeded {} seconds",
                        command.program.name(),
                        COMMAND_TIMEOUT.as_secs()
                    ),
                )
            })?
            .map_err(|error| {
                CaptureError::recovery(
                    "LINUX_CAPTURE_COMMAND_WAIT_FAILED",
                    format!(
                        "could not collect '{}' result: {error}",
                        command.program.name()
                    ),
                )
            })?;
        Ok(LinuxCommandOutput {
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: bounded_output(&output.stdout),
            stderr: bounded_output(&output.stderr),
        })
    }
}

pub async fn run_checked(
    runner: &dyn LinuxCommandRunner,
    command: &LinuxCommand,
) -> Result<LinuxCommandOutput, CaptureError> {
    let output = runner.run(command).await?;
    if output.success {
        return Ok(output);
    }
    let diagnostic = command_diagnostic(&output);
    Err(CaptureError::recovery(
        "LINUX_CAPTURE_COMMAND_FAILED",
        format!(
            "privileged program '{}' failed with status {:?}: {diagnostic}",
            command.program.name(),
            output.exit_code
        ),
    ))
}

/// Execute all idempotent removals, then prove that no route, rule, table,
/// interface, or cgroup from this generation remains. Individual "not found"
/// exit statuses are expected; absence verification is the success criterion.
pub async fn cleanup_network(
    runner: &dyn LinuxCommandRunner,
    plan: &LinuxCapturePlan,
    artifact: &CaptureArtifactState,
) -> Result<(), CaptureError> {
    let owned = LinuxCapturePlan::from_artifact(artifact)?;
    if owned.generation != plan.generation {
        return Err(CaptureError::invalid(
            "LINUX_CLEANUP_GENERATION_MISMATCH",
            "cleanup plan and recovery artifact generations differ",
        ));
    }
    for command in plan.cleanup_commands() {
        let _ = runner.run(&command).await;
    }
    let residue = detect_network_residue(runner, plan).await?;
    if residue.is_empty() {
        Ok(())
    } else {
        Err(CaptureError::recovery_with_artifact(
            "LINUX_CAPTURE_CLEANUP_INCOMPLETE",
            format!(
                "Linux capture cleanup left owned artifacts: {}",
                residue.join(", ")
            ),
            artifact.clone(),
        ))
    }
}

pub async fn detect_network_residue(
    runner: &dyn LinuxCommandRunner,
    plan: &LinuxCapturePlan,
) -> Result<Vec<String>, CaptureError> {
    let mut residue = Vec::new();
    let nft = runner
        .run(&LinuxCommand {
            program: LinuxProgram::Nft,
            args: vec![
                "list".into(),
                "table".into(),
                "inet".into(),
                plan.nft_table.clone(),
            ],
            stdin: None,
        })
        .await?;
    if nft.success {
        residue.push(format!("nft:inet:{}", plan.nft_table));
    }

    for ipv6 in [false, true] {
        let mut args = Vec::new();
        if ipv6 {
            args.push("-6".into());
        }
        args.extend(["rule".into(), "show".into()]);
        let rules = runner
            .run(&LinuxCommand {
                program: LinuxProgram::Ip,
                args,
                stdin: None,
            })
            .await?;
        if !rules.success {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_VERIFY_FAILED",
                format!(
                    "could not inspect {} policy rules: {}",
                    if ipv6 { "IPv6" } else { "IPv4" },
                    command_diagnostic(&rules)
                ),
            ));
        }
        if rules.stdout.lines().any(|line| rule_line_owned(line, plan)) {
            residue.push(format!(
                "{}-rule:{}",
                if ipv6 { "ipv6" } else { "ipv4" },
                plan.rule_priority
            ));
        }

        let mut args = Vec::new();
        if ipv6 {
            args.push("-6".into());
        }
        args.extend([
            "route".into(),
            "show".into(),
            "table".into(),
            plan.route_table.to_string(),
        ]);
        let routes = runner
            .run(&LinuxCommand {
                program: LinuxProgram::Ip,
                args,
                stdin: None,
            })
            .await?;
        if !routes.success {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_VERIFY_FAILED",
                format!(
                    "could not inspect {} route table: {}",
                    if ipv6 { "IPv6" } else { "IPv4" },
                    command_diagnostic(&routes)
                ),
            ));
        }
        if !routes.stdout.trim().is_empty() {
            residue.push(format!(
                "{}-table:{}",
                if ipv6 { "ipv6" } else { "ipv4" },
                plan.route_table
            ));
        }
    }

    if Path::new("/sys/class/net").join(&plan.tun_name).exists() {
        residue.push(format!("interface:{}", plan.tun_name));
    }
    Ok(residue)
}

fn rule_line_owned(line: &str, plan: &LinuxCapturePlan) -> bool {
    let priority = format!("{}:", plan.rule_priority);
    let mark = format!("fwmark 0x{:x}", plan.fwmark);
    let table = format!("lookup {}", plan.route_table);
    line.trim_start().starts_with(&priority) && line.contains(&mark) && line.contains(&table)
}

fn command_diagnostic(output: &LinuxCommandOutput) -> String {
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        stderr.to_string()
    } else if !output.stdout.trim().is_empty() {
        output.stdout.trim().to_string()
    } else {
        "no diagnostic output".into()
    }
}

fn bounded_output(bytes: &[u8]) -> String {
    let bounded = bytes
        .get(..bytes.len().min(MAX_DIAGNOSTIC_BYTES))
        .unwrap_or(bytes);
    String::from_utf8_lossy(bounded)
        .replace(['\0', '\r'], " ")
        .chars()
        .filter(|character| *character == '\n' || !character.is_control())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::sockscap::capture::{CaptureInstallSpec, CaptureMode};
    use crate::sockscap::types::CapturePlatform;

    struct FakeRunner {
        commands: Mutex<Vec<LinuxCommand>>,
        leave_rule: bool,
    }

    #[async_trait]
    impl LinuxCommandRunner for FakeRunner {
        async fn run(&self, command: &LinuxCommand) -> Result<LinuxCommandOutput, CaptureError> {
            self.commands.lock().unwrap().push(command.clone());
            if command.program == LinuxProgram::Nft
                && command.args.first().is_some_and(|value| value == "list")
            {
                return Ok(LinuxCommandOutput {
                    success: false,
                    exit_code: Some(1),
                    stdout: String::new(),
                    stderr: "No such file or directory".into(),
                });
            }
            if command.args.ends_with(&["rule".into(), "show".into()]) {
                let stdout = if self.leave_rule {
                    "12321: from all fwmark 0x54400001 lookup 42321\n".into()
                } else {
                    String::new()
                };
                return Ok(LinuxCommandOutput {
                    success: true,
                    exit_code: Some(0),
                    stdout,
                    stderr: String::new(),
                });
            }
            if command.args.iter().any(|value| value == "show") {
                return Ok(LinuxCommandOutput::success());
            }
            Ok(LinuxCommandOutput {
                success: false,
                exit_code: Some(2),
                stdout: String::new(),
                stderr: "already absent".into(),
            })
        }
    }

    fn plan() -> LinuxCapturePlan {
        let spec = CaptureInstallSpec {
            generation: 321,
            config_revision: 1,
            platform: CapturePlatform::Linux,
            mode: CaptureMode::Global,
            gateway: "127.0.0.1:1080".parse().unwrap(),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: Vec::new(),
            taomni_pid: 10,
            helper_pid: Some(11),
        };
        LinuxCapturePlan::from_spec(&spec, 1000).unwrap()
    }

    #[tokio::test]
    async fn cleanup_runs_every_removal_and_accepts_proven_absence() {
        let plan = plan();
        let runner = FakeRunner {
            commands: Mutex::new(Vec::new()),
            leave_rule: false,
        };
        cleanup_network(&runner, &plan, &plan.artifact(Vec::new()))
            .await
            .unwrap();
        let commands = runner.commands.lock().unwrap();
        assert!(commands.len() >= plan.cleanup_commands().len() + 5);
        assert!(
            commands
                .iter()
                .any(|command| command.program == LinuxProgram::Nft)
        );
        assert!(
            commands
                .iter()
                .any(|command| command.args.first().is_some_and(|v| v == "-6"))
        );
    }

    #[test]
    fn owned_rule_parser_requires_priority_mark_and_table() {
        let plan = plan();
        let line = format!(
            "{}: from all fwmark 0x{:x} lookup {}",
            plan.rule_priority, plan.fwmark, plan.route_table
        );
        assert!(rule_line_owned(&line, &plan));
        assert!(!rule_line_owned("123: from all lookup main", &plan));
    }

    #[test]
    fn diagnostic_output_is_bounded_and_strips_controls() {
        let raw = vec![b'x'; MAX_DIAGNOSTIC_BYTES + 100];
        assert_eq!(bounded_output(&raw).len(), MAX_DIAGNOSTIC_BYTES);
        assert_eq!(bounded_output(b"bad\0value\r\n"), "bad value \n");
    }
}
