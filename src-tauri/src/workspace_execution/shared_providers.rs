use super::*;

pub(super) fn provider_project<'a>(
    builder: &'a ModelBuilder,
    reference: Option<&str>,
) -> Result<&'a ProjectModel, String> {
    let Some(reference) = reference.map(str::trim).filter(|value| !value.is_empty()) else {
        return if builder.projects.len() == 1 {
            Ok(&builder.projects[0])
        } else {
            Err(
                "`project` is required when the workspace contains zero or multiple projects"
                    .to_string(),
            )
        };
    };
    let mut matches = builder.projects.iter().filter(|project| {
        project.id == reference
            || project.module == reference
            || project.provider == reference
            || project.root == reference
    });
    let Some(project) = matches.next() else {
        return Err(format!("unknown project `{reference}`"));
    };
    if matches.next().is_some() {
        return Err(format!(
            "project reference `{reference}` is ambiguous; use a project id"
        ));
    }
    Ok(project)
}

pub(super) fn portable_reference_matches(
    reference: &str,
    id: &str,
    kind: &str,
    label: &str,
) -> bool {
    reference == id
        || reference == kind
        || reference == label
        || reference == format!("{kind}:{label}")
}

pub(super) fn provider_run_configuration<'a>(
    builder: &'a ModelBuilder,
    reference: &str,
    project_id: Option<&str>,
) -> Result<Option<&'a RunConfiguration>, String> {
    let matches = builder
        .run_configurations
        .iter()
        .filter(|candidate| project_id.is_none_or(|id| candidate.project_id == id))
        .filter(|candidate| {
            portable_reference_matches(reference, &candidate.id, &candidate.kind, &candidate.label)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(None),
        [configuration] => Ok(Some(*configuration)),
        _ => Err(format!(
            "provider base `{reference}` is ambiguous; add `project` or use `kind:label`"
        )),
    }
}

pub(super) fn provider_debug_configuration<'a>(
    builder: &'a ModelBuilder,
    reference: &str,
    project_id: Option<&str>,
) -> Result<Option<&'a DebugConfiguration>, String> {
    let matches = builder
        .debug_configurations
        .iter()
        .filter(|candidate| project_id.is_none_or(|id| candidate.project_id == id))
        .filter(|candidate| {
            portable_reference_matches(
                reference,
                &candidate.id,
                &candidate.adapter_id,
                &candidate.label,
            )
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(None),
        [configuration] => Ok(Some(*configuration)),
        _ => Err(format!(
            "provider base `{reference}` is ambiguous; add `project` or use `adapterId:label`"
        )),
    }
}

pub(super) fn resolve_build_references(
    builder: &ModelBuilder,
    references: Vec<String>,
    project_id: &str,
) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for reference in references {
        let matches = builder
            .build_targets
            .iter()
            .filter(|target| target.project_id == project_id)
            .filter(|target| {
                portable_reference_matches(&reference, &target.id, &target.kind, &target.label)
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => return Err(format!("unknown Before launch target `{reference}`")),
            [target] => result.push(target.id.clone()),
            _ => {
                return Err(format!(
                    "Before launch target `{reference}` is ambiguous; use `kind:label`"
                ));
            }
        }
    }
    Ok(result)
}

/// Resolve a compound child using the same portable reference rules as `base`.
/// Shared ids are deliberately converted to the generated model ids so the
/// frontend can execute a compound without knowing repository-file syntax.
pub(super) fn resolve_compound_child_id(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
    reference: &str,
    project_id: &str,
    debug: bool,
) -> Result<String, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("compound child reference must not be empty".to_string());
    }
    let shared = resolved.iter().find(|candidate| {
        candidate.id == reference
            || format!("shared-run:{}", candidate.id) == reference
            || format!("shared-debug:{}", candidate.id) == reference
    });
    if let Some(candidate) = shared {
        if !debug {
            if candidate.run.is_some() || candidate.compound.is_some() {
                return Ok(format!("shared-run:{}", candidate.id));
            }
        } else if candidate.debug.is_some() || candidate.compound.is_some() {
            return Ok(format!("shared-debug:{}", candidate.id));
        } else if let Some(reference) = candidate.debug_reference.as_deref() {
            // A shared run may inherit its debug target from a provider or
            // another shared entry. Resolve that reference before emitting the
            // compound model id.
            if let Some(debug) = provider_debug_configuration(builder, reference, Some(project_id))?
            {
                return Ok(debug.id.clone());
            }
            if let Some(run) = provider_run_configuration(builder, reference, Some(project_id))? {
                if let Some(debug_id) = &run.debug_configuration_id {
                    return Ok(debug_id.clone());
                }
            }
            if let Some(shared_debug) = resolved.iter().find(|item| item.id == reference) {
                if shared_debug.debug.is_some() || shared_debug.compound.is_some() {
                    return Ok(format!("shared-debug:{reference}"));
                }
            }
        }
        return Err(format!(
            "compound child `{reference}` does not define a {} target",
            if debug { "debug" } else { "run" }
        ));
    }
    if debug {
        if let Some(configuration) =
            provider_debug_configuration(builder, reference, Some(project_id))?
        {
            return Ok(configuration.id.clone());
        }
        if let Some(run) = provider_run_configuration(builder, reference, Some(project_id))? {
            if let Some(debug_id) = &run.debug_configuration_id {
                return Ok(debug_id.clone());
            }
        }
    } else if let Some(configuration) =
        provider_run_configuration(builder, reference, Some(project_id))?
    {
        return Ok(configuration.id.clone());
    }
    Err(format!("unknown compound child `{reference}`"))
}

pub(super) fn resolve_compound_children(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
    configuration: &ResolvedSharedConfiguration,
    debug: bool,
) -> Result<Vec<String>, String> {
    let Some(compound) = &configuration.compound else {
        return Err("configuration is not compound".to_string());
    };
    let mut result = Vec::with_capacity(compound.configurations.len());
    for reference in &compound.configurations {
        let child_id = resolve_compound_child_id(
            resolved,
            builder,
            reference,
            &configuration.project_id,
            debug,
        )?;
        let child_project = if let Some(shared_id) = child_id.strip_prefix("shared-run:") {
            resolved
                .iter()
                .find(|item| item.id == shared_id)
                .map(|item| &item.project_id)
        } else if let Some(shared_id) = child_id.strip_prefix("shared-debug:") {
            resolved
                .iter()
                .find(|item| item.id == shared_id)
                .map(|item| &item.project_id)
        } else if debug {
            builder
                .debug_configurations
                .iter()
                .find(|item| item.id == child_id)
                .map(|item| &item.project_id)
        } else {
            builder
                .run_configurations
                .iter()
                .find(|item| item.id == child_id)
                .map(|item| &item.project_id)
        };
        if child_project.is_some_and(|project| project != &configuration.project_id) {
            return Err(format!(
                "compound child `{reference}` belongs to another project"
            ));
        }
        result.push(child_id);
    }
    Ok(result)
}

pub(super) fn resolve_compound_plan_ids(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
    configuration: &ResolvedSharedConfiguration,
    debug: bool,
) -> Result<Vec<String>, String> {
    fn is_cycle_error(error: &str) -> bool {
        error.contains("compound configuration cycle")
    }

    fn visit(
        resolved: &[ResolvedSharedConfiguration],
        builder: &ModelBuilder,
        configuration: &ResolvedSharedConfiguration,
        debug: bool,
        visiting: &mut Vec<String>,
    ) -> Result<Vec<String>, String> {
        if let Some(index) = visiting.iter().position(|id| id == &configuration.id) {
            let mut cycle = visiting[index..].to_vec();
            cycle.push(configuration.id.clone());
            return Err(format!(
                "compound configuration cycle: {}",
                cycle.join(" -> ")
            ));
        }
        visiting.push(configuration.id.clone());
        let child_ids = resolve_compound_children(resolved, builder, configuration, debug)?;
        for child_id in &child_ids {
            let shared_id = if debug {
                child_id.strip_prefix("shared-debug:")
            } else {
                child_id.strip_prefix("shared-run:")
            };
            let Some(shared_id) = shared_id else {
                continue;
            };
            let Some(child) = resolved.iter().find(|item| item.id == shared_id) else {
                return Err(format!("unknown compound child `{shared_id}`"));
            };
            if child.compound.is_some() {
                visit(resolved, builder, child, debug, visiting).map_err(|error| {
                    if is_cycle_error(&error) {
                        error
                    } else {
                        format!(
                            "compound child `{}` is not valid for {}: {error}",
                            child.id,
                            if debug { "Debug" } else { "Run" }
                        )
                    }
                })?;
            }
        }
        visiting.pop();
        Ok(child_ids)
    }

    visit(resolved, builder, configuration, debug, &mut Vec::new())
}

pub(super) fn validate_compound_configurations(
    resolved: &[ResolvedSharedConfiguration],
    builder: &ModelBuilder,
) -> Result<(), String> {
    for configuration in resolved.iter().filter(|item| item.compound.is_some()) {
        let run = resolve_compound_plan_ids(resolved, builder, configuration, false);
        let debug = resolve_compound_plan_ids(resolved, builder, configuration, true);
        if let Some(error) = run
            .as_ref()
            .err()
            .filter(|error| error.contains("compound configuration cycle"))
            .or_else(|| {
                debug
                    .as_ref()
                    .err()
                    .filter(|error| error.contains("compound configuration cycle"))
            })
        {
            return Err(error.clone());
        }
        if let (Err(run_error), Err(debug_error)) = (run, debug) {
            return Err(format!(
                "compound configuration `{}` has no valid execution mode; Run: {run_error}; Debug: {debug_error}",
                configuration.id
            ));
        }
    }
    Ok(())
}

pub(super) fn run_from_provider(base: &RunConfiguration) -> ResolvedSharedRun {
    ResolvedSharedRun {
        executable: base.command.executable.clone(),
        args: base.command.args.clone(),
        cwd: base.command.cwd.clone(),
        env: base.command.env.clone(),
        display: Some(base.command.display.clone()),
        runtime_options: base.runtime_options.clone(),
        env_file: base.env_file.clone(),
        argument_strategy: base.argument_strategy.clone(),
        environment_modes: base.environment_modes.clone(),
    }
}

pub(super) fn debug_from_provider(base: &DebugConfiguration) -> ResolvedSharedDebug {
    ResolvedSharedDebug {
        adapter_id: base.adapter_id.clone(),
        request: base.request.clone(),
        // Re-probe the merged adapter command below. A shared configuration may
        // replace a provider's missing executable with a repository-specific one.
        available: None,
        launch_config: base.launch_config.clone(),
        env_file: None,
    }
}

pub(super) fn apply_resolved_run(
    run: &mut ResolvedSharedRun,
    patch: SharedRunSpec,
    workspace_root: &Path,
    project_root: &Path,
) -> Result<(), String> {
    if let Some(executable) = patch.executable {
        run.executable = resolve_shared_executable(&executable, workspace_root, project_root);
    }
    if let Some(args) = patch.args {
        validate_string_list(&args, "run.args")?;
        run.args = args
            .into_iter()
            .map(|value| expand_shared_string(&value, workspace_root, project_root))
            .collect();
    }
    if let Some(cwd) = patch.cwd {
        run.cwd = resolve_shared_path(&cwd, workspace_root, project_root);
    }
    if let Some(env) = patch.env {
        validate_shared_env(&env, "run.env")?;
        run.env.extend(env.into_iter().map(|(name, value)| {
            (
                name,
                expand_shared_string(&value, workspace_root, project_root),
            )
        }));
    }
    if patch.display.is_some() {
        run.display = patch.display;
    }
    if let Some(options) = patch.runtime_options {
        validate_string_list(&options, "run.runtimeOptions")?;
        run.runtime_options = Some(options);
    }
    if let Some(env_file) = patch.env_file {
        run.env_file = Some(resolve_shared_path(&env_file, workspace_root, project_root));
    }
    if let Some(strategy) = patch.argument_strategy {
        if !matches!(
            strategy.as_str(),
            "append" | "maven-exec" | "gradle-javaexec"
        ) {
            return Err(format!("invalid run.argumentStrategy `{strategy}`"));
        }
        run.argument_strategy = Some(strategy);
    }
    if let Some(modes) = patch.environment_modes {
        validate_shared_env(&modes, "run.environmentModes")?;
        if let Some((name, mode)) = modes
            .iter()
            .find(|(_, mode)| !matches!(mode.as_str(), "append" | "replace"))
        {
            return Err(format!("invalid environment mode `{mode}` for `{name}`"));
        }
        run.environment_modes
            .get_or_insert_with(BTreeMap::new)
            .extend(modes);
    }
    Ok(())
}

pub(super) fn apply_resolved_debug(
    debug: &mut ResolvedSharedDebug,
    patch: SharedDebugSpec,
    workspace_root: &Path,
    project_root: &Path,
) -> Result<(), String> {
    if let Some(adapter_id) = patch.adapter_id {
        validate_shared_identifier(&adapter_id, "debug.adapterId")?;
        debug.adapter_id = adapter_id;
    }
    if let Some(request) = patch.request {
        if !matches!(request.as_str(), "launch" | "attach") {
            return Err(format!("invalid debug.request `{request}`"));
        }
        debug.request = request;
    }
    if patch.available.is_some() {
        debug.available = patch.available;
    }
    if let Some(mut launch_config) = patch.launch_config {
        if !launch_config.is_object() {
            return Err("`debug.launchConfig` must be an object".to_string());
        }
        expand_shared_value(&mut launch_config, workspace_root, project_root);
        debug.launch_config = launch_config;
    }
    if let Some(env_file) = patch.env_file {
        debug.env_file = Some(resolve_shared_path(&env_file, workspace_root, project_root));
    }
    if let Some(object) = debug.launch_config.as_object_mut() {
        object.insert("request".to_string(), Value::String(debug.request.clone()));
    }
    Ok(())
}
