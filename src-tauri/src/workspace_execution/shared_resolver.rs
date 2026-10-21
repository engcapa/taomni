use super::*;

pub(super) fn resolve_shared_configuration(
    mut configuration: SharedConfiguration,
    builder: &ModelBuilder,
    workspace_root: &Path,
) -> Result<ResolvedSharedConfiguration, String> {
    validate_shared_identifier(&configuration.id, "id")?;
    apply_shared_platform(&mut configuration);
    if let Some(compound) = &configuration.compound {
        if compound.configurations.is_empty() {
            return Err("compound configuration must list at least one child".to_string());
        }
        let mut children = BTreeSet::new();
        for child in &compound.configurations {
            validate_shared_identifier(child, "compound.configurations entry")?;
            if !children.insert(child.trim()) {
                return Err(format!(
                    "compound configuration contains duplicate child `{child}`"
                ));
            }
        }
        if configuration.run.is_some()
            || configuration.debug.is_some()
            || configuration.base.is_some()
            || configuration.debug_reference.is_some()
        {
            return Err("compound configuration cannot also define run, debug, base, or debugConfigurationId".to_string());
        }
    }

    let requested_project = configuration
        .project_id
        .as_deref()
        .or(configuration.project.as_deref())
        .map(|reference| provider_project(builder, Some(reference)))
        .transpose()?;
    let provider_run = configuration
        .base
        .as_deref()
        .map(|reference| {
            provider_run_configuration(
                builder,
                reference,
                requested_project.map(|project| project.id.as_str()),
            )
        })
        .transpose()?
        .flatten();
    let provider_debug = if provider_run.is_none() {
        configuration
            .base
            .as_deref()
            .map(|reference| {
                provider_debug_configuration(
                    builder,
                    reference,
                    requested_project.map(|project| project.id.as_str()),
                )
            })
            .transpose()?
            .flatten()
    } else {
        None
    };
    if configuration.base.is_some() && provider_run.is_none() && provider_debug.is_none() {
        return Err(format!(
            "unknown provider base `{}`",
            configuration.base.as_deref().unwrap_or_default()
        ));
    }

    let project_reference = configuration
        .project_id
        .as_deref()
        .or(configuration.project.as_deref());
    let standalone_project;
    let project = if let Some(base) = provider_run {
        builder
            .projects
            .iter()
            .find(|project| project.id == base.project_id)
            .ok_or_else(|| format!("provider base `{}` has no project", base.id))?
    } else if let Some(base) = provider_debug {
        builder
            .projects
            .iter()
            .find(|project| project.id == base.project_id)
            .ok_or_else(|| format!("provider base `{}` has no project", base.id))?
    } else if builder.projects.is_empty() && project_reference.is_none() {
        standalone_project = shared_project_model(workspace_root);
        &standalone_project
    } else {
        requested_project.unwrap_or(provider_project(builder, project_reference)?)
    };
    if project_reference.is_some()
        && !matches!(provider_project(builder, project_reference), Ok(candidate) if candidate.id == project.id)
    {
        return Err("`project` does not match the selected provider base".to_string());
    }
    let project_root = Path::new(&project.root);

    let source_file = configuration
        .source_file
        .as_deref()
        .map(|value| resolve_shared_path(value, workspace_root, project_root))
        .or_else(|| {
            provider_run
                .and_then(|base| base.source_file.clone())
                .or_else(|| provider_debug.and_then(|base| base.source_file.clone()))
        });
    let before_launch_references = configuration.before_launch.clone().unwrap_or_else(|| {
        provider_run
            .map(|base| base.pre_launch_targets.clone())
            .or_else(|| provider_debug.map(|base| base.pre_launch_targets.clone()))
            .unwrap_or_default()
    });
    let before_launch = resolve_build_references(builder, before_launch_references, &project.id)?;

    let mut run = if let Some(base) = provider_run {
        Some(run_from_provider(base))
    } else {
        configuration.run.as_ref().map(|_| ResolvedSharedRun {
            cwd: project.root.clone(),
            ..ResolvedSharedRun::default()
        })
    };
    if let Some(patch) = configuration.run {
        apply_resolved_run(
            run.get_or_insert_with(|| ResolvedSharedRun {
                cwd: project.root.clone(),
                ..ResolvedSharedRun::default()
            }),
            patch,
            workspace_root,
            project_root,
        )?;
    }
    if let Some(run) = &run {
        validate_shared_identifier(&run.executable, "run.executable")?;
    }

    let mut debug = if let Some(base) = provider_debug {
        Some(debug_from_provider(base))
    } else if let Some(base) = provider_run.and_then(|run| {
        run.debug_configuration_id.as_ref().and_then(|id| {
            builder
                .debug_configurations
                .iter()
                .find(|debug| debug.id == *id)
        })
    }) {
        Some(debug_from_provider(base))
    } else {
        configuration
            .debug
            .as_ref()
            .map(|_| ResolvedSharedDebug::default())
    };
    if let Some(patch) = configuration.debug {
        apply_resolved_debug(
            debug.get_or_insert_with(ResolvedSharedDebug::default),
            patch,
            workspace_root,
            project_root,
        )?;
    }
    if let Some(debug) = &debug {
        validate_shared_identifier(&debug.adapter_id, "debug.adapterId")?;
        if !debug.launch_config.is_object() {
            return Err("`debug.launchConfig` must be an object".to_string());
        }
    }
    if run.is_none() && debug.is_none() && configuration.compound.is_none() {
        return Err("configuration must define `run`, `debug`, or a provider `base`".to_string());
    }

    Ok(ResolvedSharedConfiguration {
        id: configuration.id.trim().to_string(),
        label: configuration
            .name
            .or(configuration.label)
            .unwrap_or_else(|| configuration.id.clone()),
        kind: configuration
            .kind
            .or_else(|| provider_run.map(|base| base.kind.clone()))
            .unwrap_or_else(|| "shared".to_string()),
        project_id: project.id.clone(),
        source_file,
        before_launch,
        run,
        debug,
        debug_reference: configuration.debug_reference,
        compound: configuration.compound,
    })
}

pub(super) fn merge_shared_configurations(builder: &mut ModelBuilder, workspace_root: &Path) {
    let path = workspace_root.join(SHARED_RUN_CONFIG_RELATIVE_PATH);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration: read {}: {error}",
                path.display()
            ));
            return;
        }
    };
    if contents.len() as u64 > MAX_SOURCE_BYTES {
        builder.diagnostics.push(format!(
            "Shared Run/Debug configuration: {} exceeds the 2 MiB limit",
            path.display()
        ));
        return;
    }
    let file: SharedConfigurationFile = match serde_json::from_str(&contents) {
        Ok(file) => file,
        Err(error) => {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration: parse {}: {error}",
                path.display()
            ));
            return;
        }
    };
    let configurations = match migrate_shared_file(file) {
        Ok(configurations) => configurations,
        Err(error) => {
            builder
                .diagnostics
                .push(format!("Shared Run/Debug configuration: {error}"));
            return;
        }
    };
    let mut ids = BTreeSet::new();
    for configuration in &configurations {
        if !ids.insert(configuration.id.trim().to_string()) {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration `{}`: duplicate id",
                configuration.id
            ));
        }
    }
    if !builder.diagnostics.is_empty() {
        return;
    }
    let known_adapter_ids = ["java", "lldb", "delve", "python", "node", "coreclr"]
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut resolved = Vec::new();
    for configuration in configurations {
        let id = configuration.id.clone();
        match resolve_shared_configuration(configuration, builder, workspace_root) {
            Ok(configuration) => resolved.push(configuration),
            Err(error) => builder
                .diagnostics
                .push(format!("Shared Run/Debug configuration `{id}`: {error}")),
        }
    }
    if !builder.diagnostics.is_empty() {
        return;
    }
    if let Err(error) = validate_compound_configurations(&resolved, builder) {
        builder
            .diagnostics
            .push(format!("Shared Run/Debug configuration: {error}"));
        return;
    }

    if builder.projects.is_empty() && !resolved.is_empty() {
        builder.register_project(shared_project_model(workspace_root));
    }

    let shared_debug_ids = resolved
        .iter()
        .filter(|configuration| {
            configuration.debug.is_some()
                || (configuration.compound.is_some()
                    && resolve_compound_plan_ids(&resolved, builder, configuration, true).is_ok())
        })
        .map(|configuration| configuration.id.clone())
        .collect::<BTreeSet<_>>();
    let provider_debug_ids = builder
        .debug_configurations
        .iter()
        .map(|configuration| configuration.id.clone())
        .collect::<BTreeSet<_>>();
    for configuration in &resolved {
        let Some(reference) = configuration.debug_reference.as_deref() else {
            continue;
        };
        if !provider_debug_ids.contains(reference) && !shared_debug_ids.contains(reference) {
            builder.diagnostics.push(format!(
                "Shared Run/Debug configuration `{}`: unknown debug reference `{reference}`",
                configuration.id
            ));
        }
    }
    if !builder.diagnostics.is_empty() {
        return;
    }
    let resolved_snapshot = resolved.clone();
    for configuration in resolved {
        let compound_run_plan = configuration
            .compound
            .as_ref()
            .map(|_| resolve_compound_plan_ids(&resolved_snapshot, builder, &configuration, false));
        let compound_debug_plan = configuration
            .compound
            .as_ref()
            .map(|_| resolve_compound_plan_ids(&resolved_snapshot, builder, &configuration, true));
        let compound_run_ids = compound_run_plan
            .as_ref()
            .and_then(|plan| plan.as_ref().ok())
            .cloned();
        let compound_debug_ids = compound_debug_plan
            .as_ref()
            .and_then(|plan| plan.as_ref().ok())
            .cloned();
        let compound_debug_error = compound_debug_plan
            .as_ref()
            .and_then(|plan| plan.as_ref().err())
            .cloned();
        let debug_id = configuration
            .debug
            .clone()
            .map(|debug| {
                let id = format!("shared-debug:{}", configuration.id);
                let adapter_available = known_adapter_ids.contains(debug.adapter_id.as_str());
                let adapter_command_available = debug
                    .launch_config
                    .get("adapterCommand")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .and_then(resolve_candidate)
                    .is_some();
                let available = debug.available.unwrap_or(true)
                    && adapter_available
                    && (debug.adapter_id == "java" || adapter_command_available);
                let diagnostic = if !adapter_available {
                    Some(format!(
                        "Debug adapter `{}` is not registered by Code Workspace",
                        debug.adapter_id
                    ))
                } else if debug.adapter_id != "java" && !adapter_command_available {
                    Some(format!(
                        "Debug adapter executable for `{}` was not found",
                        debug.adapter_id
                    ))
                } else if !debug.available.unwrap_or(true) {
                    Some("Shared configuration explicitly disabled this debug target".to_string())
                } else {
                    None
                };
                builder.debug_configurations.push(DebugConfiguration {
                    id: id.clone(),
                    project_id: configuration.project_id.clone(),
                    label: configuration.label.clone(),
                    adapter_id: debug.adapter_id,
                    request: debug.request,
                    available,
                    diagnostic,
                    pre_launch_targets: configuration.before_launch.clone(),
                    source_file: configuration.source_file.clone(),
                    launch_config: debug.launch_config,
                    env_file: debug.env_file,
                    configuration_source: Some("shared".to_string()),
                    compound_configuration_ids: configuration
                        .compound
                        .as_ref()
                        .and(compound_debug_ids.clone()),
                    compound_parallel: configuration
                        .compound
                        .as_ref()
                        .and_then(|compound| compound.parallel),
                    compound_stop_on_failure: configuration
                        .compound
                        .as_ref()
                        .and_then(|compound| compound.stop_on_failure),
                });
                id
            })
            .or_else(|| {
                configuration.debug_reference.as_ref().map(|reference| {
                    if shared_debug_ids.contains(reference.as_str()) {
                        format!("shared-debug:{reference}")
                    } else {
                        reference.clone()
                    }
                })
            });
        let project_id = configuration.project_id.clone();
        let source_file = configuration.source_file.clone();
        let pre_launch_targets = configuration.before_launch.clone();
        let project_cwd = builder
            .projects
            .iter()
            .find(|project| project.id == configuration.project_id)
            .map(|project| project.root.clone())
            .unwrap_or_else(|| path_string(workspace_root));
        let label = configuration.label.clone();
        if let Some(run) = configuration.run {
            let display = run.display.unwrap_or_else(|| {
                std::iter::once(shell_preview(&run.executable))
                    .chain(run.args.iter().map(|arg| shell_preview(arg)))
                    .collect::<Vec<_>>()
                    .join(" ")
            });
            let source = if resolve_candidate(&run.executable).is_some() {
                "configured"
            } else {
                "path"
            };
            let error = (resolve_candidate(&run.executable).is_none()).then(|| {
                format!(
                    "Shared executable `{}` was not found on this platform",
                    run.executable
                )
            });
            builder.run_configurations.push(RunConfiguration {
                id: format!("shared-run:{}", configuration.id),
                project_id,
                label: label.clone(),
                kind: configuration.kind,
                command: ExecutionCommand {
                    executable: run.executable,
                    args: run.args,
                    cwd: run.cwd,
                    env: run.env,
                    display,
                    source: source.to_string(),
                    error,
                },
                source_file,
                pre_launch_targets: pre_launch_targets,
                debug_configuration_id: debug_id,
                runtime_options: run.runtime_options,
                env_file: run.env_file,
                argument_strategy: run.argument_strategy,
                environment_modes: run.environment_modes,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: configuration
                    .compound
                    .as_ref()
                    .and(compound_run_ids.clone()),
                compound_parallel: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.parallel),
                compound_stop_on_failure: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.stop_on_failure),
            });
        } else if let Some(debug_configuration_id) = debug_id {
            // Keep debug-only shared entries selectable by the editor. IDEA
            // exposes these in the same Run/Debug configuration chooser even
            // though invoking Run is unavailable; the explicit error keeps the
            // Run panel from attempting to spawn a sentinel executable.
            builder.run_configurations.push(RunConfiguration {
                id: format!("shared-run:{}", configuration.id),
                project_id,
                label: configuration.label,
                kind: "debug-only".to_string(),
                command: ExecutionCommand {
                    executable: "__taomni_debug_only__".to_string(),
                    args: Vec::new(),
                    cwd: project_cwd,
                    env: BTreeMap::new(),
                    display: "Debug only".to_string(),
                    source: "configured".to_string(),
                    error: Some(
                        "This configuration is debug-only; choose Debug to launch it".to_string(),
                    ),
                },
                source_file,
                pre_launch_targets,
                debug_configuration_id: Some(debug_configuration_id),
                runtime_options: None,
                env_file: None,
                argument_strategy: None,
                environment_modes: None,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: configuration.compound.as_ref().and(compound_run_ids),
                compound_parallel: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.parallel),
                compound_stop_on_failure: configuration
                    .compound
                    .as_ref()
                    .and_then(|compound| compound.stop_on_failure),
            });
        } else if configuration.compound.is_some() {
            let run_ids = compound_run_ids.clone();
            let debug_ids = compound_debug_ids.clone();
            let compound_debug_id = format!("shared-debug:{}", configuration.id);
            let compound = configuration.compound.as_ref().expect("compound exists");
            let debug_diagnostic =
                compound_debug_error.map(|error| format!("Compound Debug is unavailable: {error}"));
            let debug_available =
                debug_diagnostic.is_none() && debug_ids.as_ref().is_some_and(|ids| !ids.is_empty());
            builder.debug_configurations.push(DebugConfiguration {
                id: compound_debug_id.clone(),
                project_id: configuration.project_id.clone(),
                label: configuration.label.clone(),
                adapter_id: "compound".to_string(),
                request: "launch".to_string(),
                available: debug_available,
                diagnostic: debug_diagnostic.clone(),
                pre_launch_targets: configuration.before_launch.clone(),
                source_file: configuration.source_file.clone(),
                launch_config: json!({
                    "request": "launch",
                    "compoundConfigurations": debug_ids.clone().unwrap_or_default(),
                    "parallel": compound.parallel.unwrap_or(false),
                    "stopOnFailure": compound.stop_on_failure.unwrap_or(true),
                    "unavailableReason": debug_diagnostic,
                }),
                env_file: None,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: debug_ids,
                compound_parallel: compound.parallel,
                compound_stop_on_failure: compound.stop_on_failure,
            });
            let run_ids = run_ids.unwrap_or_default();
            let run_error = if run_ids.is_empty() {
                Some("Compound configuration has no valid Run children".to_string())
            } else {
                None
            };
            let compound = configuration.compound.as_ref().expect("compound exists");
            builder.run_configurations.push(RunConfiguration {
                id: format!("shared-run:{}", configuration.id),
                project_id: configuration.project_id.clone(),
                label: configuration.label,
                kind: "compound".to_string(),
                command: ExecutionCommand {
                    executable: "__taomni_compound__".to_string(),
                    args: Vec::new(),
                    cwd: project_cwd,
                    env: BTreeMap::new(),
                    display: "Compound configuration".to_string(),
                    source: "configured".to_string(),
                    error: run_error,
                },
                source_file,
                pre_launch_targets,
                debug_configuration_id: Some(compound_debug_id),
                runtime_options: None,
                env_file: None,
                argument_strategy: None,
                environment_modes: None,
                configuration_source: Some("shared".to_string()),
                compound_configuration_ids: Some(run_ids),
                compound_parallel: compound.parallel,
                compound_stop_on_failure: compound.stop_on_failure,
            });
        }
    }

    // Compound entries are emitted alongside their leaves, so a parent may be
    // seen before a nested child. Resolve availability after the complete graph
    // exists and propagate an unavailable leaf/child diagnostic to every parent.
    let mut availability = builder
        .debug_configurations
        .iter()
        .map(|configuration| {
            (
                configuration.id.clone(),
                (
                    configuration.available,
                    configuration.diagnostic.clone(),
                    configuration.compound_configuration_ids.clone(),
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let compound_ids = availability
        .iter()
        .filter_map(|(id, (_, _, children))| children.as_ref().map(|_| id.clone()))
        .collect::<Vec<_>>();
    for _ in 0..compound_ids.len().max(1) {
        let mut changed = false;
        for id in &compound_ids {
            let Some((true, _, Some(children))) = availability.get(id).cloned() else {
                continue;
            };
            if let Some(child_id) = children.iter().find(|child_id| {
                availability
                    .get(*child_id)
                    .is_none_or(|(available, _, _)| !available)
            }) {
                let reason = availability
                    .get(child_id)
                    .and_then(|(_, diagnostic, _)| diagnostic.clone())
                    .unwrap_or_else(|| "debug configuration is unavailable".to_string());
                availability.insert(
                    id.clone(),
                    (
                        false,
                        Some(format!(
                            "Compound Debug child `{child_id}` is unavailable: {reason}"
                        )),
                        Some(children),
                    ),
                );
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    for configuration in &mut builder.debug_configurations {
        let Some((available, diagnostic, _)) = availability.get(&configuration.id) else {
            continue;
        };
        configuration.available = *available;
        configuration.diagnostic = diagnostic.clone();
        if configuration.compound_configuration_ids.is_some() {
            if let Some(object) = configuration.launch_config.as_object_mut() {
                object.insert(
                    "unavailableReason".to_string(),
                    diagnostic.clone().map(Value::String).unwrap_or(Value::Null),
                );
            }
        }
    }
}
