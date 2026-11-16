//! Password transitions close service admission before touching Vault. Failed
//! host/drain confirmation retains its revocation for an explicit retry.
use super::{PluginRegistry, runtime::RuntimeHost, services::PluginCoreServices};
use crate::vault::Vault;
#[cfg(test)]
use crate::vault::VaultStateKind;
use std::{
    sync::{Arc, TryLockError, atomic::Ordering},
    time::{Duration, Instant},
};
use taomni_plugin_api::services::OperationId;
use taomni_plugin_services::{AdmissionState, CoreOperationPermit, Revocation};
use taomni_profile_locks::{VaultOperationLease, WaitControl};

pub(crate) const VAULT_TRANSITION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
enum Action<'a> {
    Initialize(&'a str),
    Unlock(&'a str),
    Lock,
    ChangeMaster(&'a str, &'a str),
    VerifyRestore(Option<&'a str>),
}

impl PluginRegistry {
    pub(crate) fn initialize_vault(&self, vault: &Vault, password: &str) -> Result<(), String> {
        self.vault_action(vault, Action::Initialize(password), transition_deadline())
    }

    pub(crate) fn unlock_vault(&self, vault: &Vault, password: &str) -> Result<(), String> {
        self.vault_action(vault, Action::Unlock(password), transition_deadline())
    }

    pub(crate) fn lock_vault(&self, vault: &Vault) -> Result<(), String> {
        self.lock_vault_until(vault, transition_deadline())
    }

    pub(crate) fn lock_vault_until(&self, vault: &Vault, deadline: Instant) -> Result<(), String> {
        self.vault_action(vault, Action::Lock, deadline)
    }

    pub(crate) fn change_vault_master(
        &self,
        vault: &Vault,
        old: &str,
        new: &str,
    ) -> Result<(), String> {
        self.vault_action(vault, Action::ChangeMaster(old, new), transition_deadline())
    }

    pub(crate) fn verify_restore_password(
        &self,
        vault: &Vault,
        password: Option<&str>,
    ) -> Result<(), String> {
        self.vault_action(
            vault,
            Action::VerifyRestore(password),
            transition_deadline(),
        )
    }

    pub(crate) fn with_core_reset<T>(
        &self,
        vault: &Vault,
        deadline: Instant,
        reset: impl FnOnce(&CoreOperationPermit) -> Result<T, String>,
    ) -> Result<T, String> {
        let services = self
            .services
            .as_ref()
            .ok_or("Vault services are unavailable")?;
        let mut pending = lock_until(&services.vault_transition, deadline, "Vault transition")?;
        let _lifecycle = lock_until(&self.lifecycle, deadline, "plugin lifecycle")?;
        if self.shutting_down.load(Ordering::Acquire)
            || self.quiescence.load(Ordering::Acquire) != 0
        {
            return Err("Vault transition is unavailable during application teardown".into());
        }
        if services.admission.state() == AdmissionState::Locked {
            return Err(crate::vault::ERR_VAULT_LOCKED.into());
        }
        self.drain_vault_operations(services, &mut pending, deadline)?;
        let wait = WaitControl::new(deadline, &|| false);
        let lease = VaultOperationLease::write(&services.root, &wait).map_err(|e| e.to_string())?;
        let revocation = pending.as_ref().expect("reset retains its revocation");
        if !vault.cached_root_is_current()? {
            services
                .admission
                .finish_revoke(revocation)
                .map_err(|e| e.kind().to_string())?;
            pending.take();
            return Err(crate::vault::ERR_VAULT_LOCKED.into());
        }
        let permit = services
            .admission
            .admit_core_reset_after_drain(
                OperationId::parse(uuid::Uuid::new_v4().to_string()).expect("canonical UUID"),
                revocation,
                lease,
                deadline,
            )
            .map_err(|e| e.kind().to_string())?;
        let result = reset(&permit);
        let current = permit.check_current().map_err(|e| e.kind().to_string());
        let _lease = permit.release_admission();
        services
            .admission
            .finish_revoke(revocation)
            .map_err(|e| e.kind().to_string())?;
        pending.take();
        if vault.cached_root_is_current()? {
            services
                .admission
                .after_verified_unlock()
                .map_err(|e| e.kind().to_string())?;
        }
        current?;
        result
    }

    fn vault_action(
        &self,
        vault: &Vault,
        action: Action<'_>,
        deadline: Instant,
    ) -> Result<(), String> {
        let services = self
            .services
            .as_ref()
            .ok_or("Vault services are unavailable")?;
        // The service owner has no callback/reference to this registry. No
        // Vault/DB/host mutex is held while waiting for either transition lock.
        let mut pending = lock_until(&services.vault_transition, deadline, "Vault transition")?;
        let _lifecycle = lock_until(&self.lifecycle, deadline, "plugin lifecycle")?;
        if self.shutting_down.load(Ordering::Acquire)
            || self.quiescence.load(Ordering::Acquire) != 0
        {
            return Err("Vault transition is unavailable during application teardown".into());
        }
        self.drain_vault_operations(services, &mut pending, deadline)?;
        let wait = WaitControl::new(deadline, &|| false);
        // Keep the OS lease through root validation and reopening admission;
        // another core must not rekey between verification and the new epoch.
        let _lease = match action {
            Action::Initialize(_) | Action::ChangeMaster(_, _) => {
                Some(VaultOperationLease::write(&services.root, &wait).map_err(|e| e.to_string())?)
            }
            Action::Unlock(_) | Action::VerifyRestore(_) => {
                Some(VaultOperationLease::read(&services.root, &wait).map_err(|e| e.to_string())?)
            }
            Action::Lock => None,
        };
        let result = match action {
            Action::Initialize(password) => vault.init(password),
            Action::Unlock(password) => vault.unlock(password),
            Action::ChangeMaster(old, new) => vault.change_master(old, new),
            Action::Lock => vault.lock(),
            Action::VerifyRestore(password) => vault.verify_master_password(password),
        };
        // A failed lock never claims its barrier completed. Failed password
        // checks preserve a still-current existing unlock, matching Vault's
        // retained error semantics; every old operation remains invalidated.
        if matches!(action, Action::Lock) && result.is_err() {
            return result;
        }
        if let Some(revocation) = pending.as_ref() {
            services
                .admission
                .finish_revoke(revocation)
                .map_err(|e| e.kind().to_string())?;
            pending.take();
        }
        if !matches!(action, Action::Lock) && vault.cached_root_is_current()? {
            services
                .admission
                .after_verified_unlock()
                .map_err(|e| e.kind().to_string())?;
        }
        result
    }

    pub(super) fn drain_vault_operations(
        &self,
        services: &PluginCoreServices,
        pending: &mut Option<Revocation>,
        deadline: Instant,
    ) -> Result<(), String> {
        if services.admission.state() == AdmissionState::Locked {
            return Ok(());
        }
        let runtimes = self
            .hosts
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|(slug, runtime)| (slug.clone(), runtime.clone()))
            .collect::<Vec<_>>();
        if pending.is_none() {
            let hosts = runtimes
                .iter()
                .filter_map(|(_, runtime)| {
                    runtime
                        .identity
                        .read()
                        .expect("plugin identity poisoned")
                        .clone()
                })
                .collect::<Vec<_>>();
            *pending = Some(
                services
                    .admission
                    .begin_or_join_revoke(&hosts)
                    .map_err(|e| e.kind().to_string())?,
            );
        }
        let revocation = pending
            .as_ref()
            .expect("revocation retained until completion");
        for (slug, _) in &runtimes {
            self.cancel_host_requests(slug);
        }
        for (slug, runtime) in runtimes {
            self.revoke_runtime(services, &slug, &runtime, revocation, deadline)?;
        }
        services
            .admission
            .wait_revoke_drained(deadline, &|| false)
            .map_err(|e| e.kind().to_string())
    }

    pub(super) fn complete_service_barrier(
        &self,
        services: &PluginCoreServices,
        pending: &mut Option<Revocation>,
        deadline: Instant,
        clear_root: bool,
    ) -> Result<(), String> {
        // Metadata consumers also hold a shared lease, even while locked.
        let wait = WaitControl::new(deadline, &|| false);
        let _lease =
            VaultOperationLease::write(&services.root, &wait).map_err(|e| e.to_string())?;
        if let Some(revocation) = pending.as_ref() {
            services
                .admission
                .finish_revoke(revocation)
                .map_err(|e| e.kind().to_string())?;
            pending.take();
        }
        if clear_root {
            services.vault.lock()?;
        }
        Ok(())
    }

    pub(super) fn resume_core_services(
        &self,
        services: &PluginCoreServices,
        deadline: Instant,
    ) -> Result<(), String> {
        if !services
            .resume_after_quiescence
            .swap(false, Ordering::AcqRel)
            || self.shutting_down.load(Ordering::Acquire)
            || self.quiescence.load(Ordering::Acquire) != 0
        {
            return Ok(());
        }
        let wait = WaitControl::new(deadline, &|| false);
        let _lease = VaultOperationLease::read(&services.root, &wait).map_err(|e| e.to_string())?;
        if services.admission.state() == AdmissionState::Locked
            && services.vault.cached_root_is_current()?
        {
            services
                .admission
                .after_verified_unlock()
                .map_err(|e| e.kind().to_string())?;
        }
        Ok(())
    }

    fn revoke_runtime(
        &self,
        services: &PluginCoreServices,
        slug: &str,
        runtime: &Arc<RuntimeHost>,
        revocation: &Revocation,
        deadline: Instant,
    ) -> Result<(), String> {
        let identity = runtime.identity.read().map_err(|e| e.to_string())?.clone();
        let Some(identity) = identity.filter(|host| {
            revocation.hosts.contains(host.instance()) && !host.termination_confirmed()
        }) else {
            return Ok(());
        };
        if !services
            .admission
            .host_revoke_pending(&identity, revocation)
            .map_err(|e| e.kind().to_string())?
        {
            return Ok(());
        }
        let mut process = loop {
            match runtime.process.try_lock() {
                Ok(process) => break process,
                Err(TryLockError::Poisoned(_)) => {
                    return Err(format!("{slug}: process ownership lock is poisoned"));
                }
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => {
                    return Err(format!(
                        "{slug}: timed out waiting for key revocation; retry lock"
                    ));
                }
            }
        };
        let grace = deadline.min(Instant::now() + Duration::from_secs(2));
        if process
            .revoke_keys(revocation, grace)
            .ok()
            .is_some_and(|reply| {
                services
                    .admission
                    .acknowledge_revoke(&identity, &reply)
                    .is_ok()
            })
        {
            return Ok(());
        }
        process
            .stop_confirmed(deadline)
            .map_err(|e| e.to_string())?;
        drop(process);
        *runtime.identity.write().map_err(|e| e.to_string())? = None;
        let mut hosts = self.hosts.lock().map_err(|e| e.to_string())?;
        if hosts
            .get(slug)
            .is_some_and(|current| Arc::ptr_eq(current, runtime))
        {
            hosts.remove(slug);
        }
        Ok(())
    }
}

fn transition_deadline() -> Instant {
    Instant::now() + VAULT_TRANSITION_TIMEOUT
}

pub(super) fn lock_until<'a, T>(
    mutex: &'a std::sync::Mutex<T>,
    deadline: Instant,
    owner: &str,
) -> Result<std::sync::MutexGuard<'a, T>, String> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(format!("{owner} is unavailable")),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return Err(format!("{owner} timed out; retry the operation")),
        }
    }
}

#[cfg(test)]
#[path = "vault_lifecycle_tests.rs"]
mod tests;
