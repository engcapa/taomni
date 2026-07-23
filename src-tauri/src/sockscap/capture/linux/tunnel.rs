//! Linux transparent-TCP redirect rules.
//!
//! A userspace TUN plus smoltcp does not, by itself, capture host OUTPUT
//! traffic. The production path therefore uses nftables' kernel NAT hook and
//! retrieves the pre-NAT destination with `SO_ORIGINAL_DST` in the relay.
//! Keeping rule rendering here makes all privileged input validated and easily
//! unit-testable before it is handed to `nft -f -`.

use std::net::IpAddr;
use std::path::Path;

use crate::sockscap::capture::linux::exec::run_command_elevated;
use crate::sockscap::config::ScopeMode;

const TABLE_NAME: &str = "taomni_sockscap";
/// Rendered into each terminal redirect rule so Recover can distinguish a
/// residual SocksCap table from an unrelated table that happens to use the
/// same name. The marker is intentionally stable across releases.
const OWNERSHIP_MARKER: &str = "taomni-sockscap-managed-v1";
const NFT_PATHS: &[&str] = &["/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft", "/bin/nft"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CidrFamily {
    Ipv4,
    Ipv6,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCidr {
    family: CidrFamily,
    value: String,
}

impl ValidatedCidr {
    pub fn parse(value: &str) -> Result<Self, String> {
        let value = value.trim();
        let (address, prefix) = value
            .split_once('/')
            .ok_or_else(|| format!("invalid bypass CIDR {value:?}: expected address/prefix"))?;
        let address: IpAddr = address
            .parse()
            .map_err(|_| format!("invalid bypass CIDR address {value:?}"))?;
        let prefix: u8 = prefix
            .parse()
            .map_err(|_| format!("invalid bypass CIDR prefix {value:?}"))?;
        let (family, max_prefix) = match address {
            IpAddr::V4(_) => (CidrFamily::Ipv4, 32),
            IpAddr::V6(_) => (CidrFamily::Ipv6, 128),
        };
        if prefix > max_prefix {
            return Err(format!("invalid bypass CIDR prefix {value:?}"));
        }
        Ok(Self {
            family,
            value: format!("{address}/{prefix}"),
        })
    }

    fn render_return_rule(&self) -> String {
        match self.family {
            CidrFamily::Ipv4 => format!("    ip daddr {} return\n", self.value),
            CidrFamily::Ipv6 => format!("    ip6 daddr {} return\n", self.value),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RedirectPlan {
    pub mode: ScopeMode,
    pub relay_port: u16,
    pub redirect_ipv6: bool,
    pub bypass_cidrs: Vec<ValidatedCidr>,
    pub bypass_cgroup_id: Option<u64>,
    pub capture_cgroup_ids: Vec<u64>,
}

impl RedirectPlan {
    pub fn new(
        mode: ScopeMode,
        relay_port: u16,
        redirect_ipv6: bool,
        bypass_cidrs: &[String],
        bypass_cgroup_id: Option<u64>,
        capture_cgroup_ids: &[u64],
    ) -> Result<Self, String> {
        if relay_port == 0 {
            return Err("Linux relay port must be non-zero".into());
        }
        let bypass_cidrs = bypass_cidrs
            .iter()
            .map(|cidr| ValidatedCidr::parse(cidr))
            .collect::<Result<Vec<_>, _>>()?;
        let plan = Self {
            mode,
            relay_port,
            redirect_ipv6,
            bypass_cidrs,
            bypass_cgroup_id,
            capture_cgroup_ids: capture_cgroup_ids.to_vec(),
        };
        plan.validate()?;
        Ok(plan)
    }

    fn validate(&self) -> Result<(), String> {
        match self.mode {
            ScopeMode::Global if self.bypass_cgroup_id.is_none() => Err(
                "global Linux capture requires a relay bypass cgroup; refusing to install a redirect loop"
                    .into(),
            ),
            ScopeMode::Apps if self.capture_cgroup_ids.is_empty() => {
                Err("app-mode Linux capture requires at least one capture cgroup".into())
            }
            _ => Ok(()),
        }
    }

    pub fn render_nft_script(&self) -> String {
        let mut script = format!("table inet {TABLE_NAME} {{\n  chain output {{\n");
        script.push_str("    type nat hook output priority dstnat; policy accept;\n");
        // Never redirect loopback traffic; this protects the relay's local
        // accept path even if a distribution has unusual cgroup behavior.
        script.push_str("    ip daddr 127.0.0.0/8 return\n");
        script.push_str("    ip6 daddr ::1/128 return\n");
        for cidr in &self.bypass_cidrs {
            script.push_str(&cidr.render_return_rule());
        }

        match self.mode {
            ScopeMode::Global => {
                script.push_str(&format!(
                    "    meta cgroup {} return\n",
                    self.bypass_cgroup_id.expect("validated global cgroup")
                ));
                self.render_redirect_rule(&mut script, "");
            }
            ScopeMode::Apps => {
                for cgroup_id in &self.capture_cgroup_ids {
                    self.render_redirect_rule(&mut script, &format!("meta cgroup {cgroup_id} "));
                }
            }
        }

        script.push_str("  }\n}\n");
        script
    }

    fn render_redirect_rule(&self, script: &mut String, prefix: &str) {
        let protocol = if self.redirect_ipv6 {
            "meta l4proto tcp"
        } else {
            "ip protocol tcp"
        };
        script.push_str(&format!(
            "    {prefix}{protocol} redirect to :{} comment \"{OWNERSHIP_MARKER}\"\n",
            self.relay_port
        ));
    }
}

/// Installed nftables state for one Linux SocksCap run.
#[derive(Debug)]
pub struct NftRedirect {
    installed: bool,
}

impl NftRedirect {
    pub fn preflight(sudo_password: Option<&str>) -> Result<(), String> {
        let output = run_command_elevated(nft_binary()?, &["--version"], None, sudo_password)?;
        if !output.status.success() {
            return Err(format!("nft --version failed: {}", command_error(&output)));
        }
        let output = run_command_elevated(nft_binary()?, &["list", "tables"], None, sudo_password)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "nftables is present but unavailable: {}. Linux capture requires CAP_NET_ADMIN",
                command_error(&output)
            ))
        }
    }

    pub fn install(plan: &RedirectPlan, sudo_password: Option<&str>) -> Result<Self, String> {
        plan.validate()?;
        Self::preflight(sudo_password)?;
        match table_state(sudo_password)? {
            TableState::Absent => {}
            TableState::Managed => {
                return Err(
                    "an existing managed taomni_sockscap nftables table was found; use Recover before starting another Linux capture session"
                        .into(),
                );
            }
            TableState::Unmanaged => {
                return Err(
                    "an nftables table named taomni_sockscap is not recognized as SocksCap-owned; refusing to replace it"
                        .into(),
                );
            }
        }
        run_nft_script(&plan.render_nft_script(), sudo_password)?;
        Ok(Self { installed: true })
    }

    pub fn remove(&mut self, sudo_password: Option<&str>) -> Result<(), String> {
        if !self.installed {
            return Ok(());
        }
        delete_managed_table(sudo_password)?;
        self.installed = false;
        Ok(())
    }
}

/// Remove residual capture rules after an unclean shutdown.
pub fn recover_rules(sudo_password: Option<&str>) -> Result<(), String> {
    match table_state(sudo_password)? {
        TableState::Absent => Ok(()),
        TableState::Managed => delete_table(sudo_password),
        TableState::Unmanaged => Err(
            "an nftables table named taomni_sockscap is not recognized as SocksCap-owned; refusing to delete it"
                .into(),
        ),
    }
}

fn nft_binary() -> Result<&'static str, String> {
    NFT_PATHS
        .iter()
        .copied()
        .find(|path| Path::new(path).is_file())
        .ok_or_else(|| "nftables is required for Linux SocksCap; install the nft package".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TableState {
    Absent,
    Managed,
    Unmanaged,
}

fn table_state(sudo_password: Option<&str>) -> Result<TableState, String> {
    let output = run_command_elevated(
        nft_binary()?,
        &["list", "table", "inet", TABLE_NAME],
        None,
        sudo_password,
    )?;
    if output.status.success() {
        return Ok(if managed_table_output(&output.stdout) {
            TableState::Managed
        } else {
            TableState::Unmanaged
        });
    }
    let error = command_error(&output);
    if error.contains("No such file") || error.contains("does not exist") {
        Ok(TableState::Absent)
    } else {
        Err(format!(
            "query nftables table failed: {error}. Linux capture requires CAP_NET_ADMIN"
        ))
    }
}

fn managed_table_output(stdout: &[u8]) -> bool {
    String::from_utf8_lossy(stdout).contains(OWNERSHIP_MARKER)
}

fn delete_managed_table(sudo_password: Option<&str>) -> Result<(), String> {
    match table_state(sudo_password)? {
        TableState::Absent => Ok(()),
        TableState::Managed => delete_table(sudo_password),
        TableState::Unmanaged => Err(
            "an nftables table named taomni_sockscap is not recognized as SocksCap-owned; refusing to delete it"
                .into(),
        ),
    }
}

fn delete_table(sudo_password: Option<&str>) -> Result<(), String> {
    let output = run_command_elevated(
        nft_binary()?,
        &["delete", "table", "inet", TABLE_NAME],
        None,
        sudo_password,
    )?;
    if output.status.success() {
        return Ok(());
    }
    let error = command_error(&output);
    if error.contains("No such file") || error.contains("does not exist") {
        Ok(())
    } else {
        Err(format!("delete nftables table failed: {error}"))
    }
}

fn run_nft_script(script: &str, sudo_password: Option<&str>) -> Result<(), String> {
    let output = run_command_elevated(nft_binary()?, &["-f", "-"], Some(script), sudo_password)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "install nftables redirect failed: {}. Linux capture requires CAP_NET_ADMIN",
            command_error(&output)
        ))
    }
}

fn command_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("exit status {}", output.status)
    } else {
        stderr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_untrusted_cidr_input() {
        assert!(ValidatedCidr::parse("127.0.0.1; flush ruleset").is_err());
        assert!(ValidatedCidr::parse("10.0.0.0/33").is_err());
    }

    #[test]
    fn renders_global_bypass_before_redirect() {
        let plan = RedirectPlan::new(
            ScopeMode::Global,
            18443,
            true,
            &["10.0.0.0/8".into(), "fd00::/8".into()],
            Some(42),
            &[],
        )
        .unwrap();
        let script = plan.render_nft_script();
        assert!(script.contains("meta cgroup 42 return"));
        assert!(script.contains("meta l4proto tcp redirect to :18443"));
        assert!(script.contains(OWNERSHIP_MARKER));
        assert!(
            script.find("meta cgroup 42 return").unwrap()
                < script.find("meta l4proto tcp redirect").unwrap()
        );
        assert!(script.contains("ip daddr 10.0.0.0/8 return"));
        assert!(script.contains("ip6 daddr fd00::/8 return"));
    }

    #[test]
    fn app_mode_only_redirects_selected_cgroups() {
        let plan = RedirectPlan::new(ScopeMode::Apps, 15000, true, &[], None, &[11, 22]).unwrap();
        let script = plan.render_nft_script();
        assert!(script.contains("meta cgroup 11 meta l4proto tcp redirect to :15000"));
        assert!(script.contains("meta cgroup 22 meta l4proto tcp redirect to :15000"));
        assert!(!script.contains("\n    meta l4proto tcp redirect to :15000\n"));
    }

    #[test]
    fn recognizes_only_marked_tables_as_managed() {
        assert!(managed_table_output(
            b"table inet taomni_sockscap {\n  comment \"taomni-sockscap-managed-v1\"\n}"
        ));
        assert!(!managed_table_output(b"table inet taomni_sockscap { }"));
    }

    #[test]
    fn avoids_ipv6_redirect_when_the_loopback_listener_is_unavailable() {
        let plan = RedirectPlan::new(ScopeMode::Apps, 15000, false, &[], None, &[11]).unwrap();
        assert!(
            plan.render_nft_script()
                .contains("meta cgroup 11 ip protocol tcp redirect to :15000")
        );
    }
}
