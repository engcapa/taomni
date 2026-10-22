use super::*;

pub(super) fn shared_platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub(super) fn expand_shared_string(
    value: &str,
    workspace_root: &Path,
    project_root: &Path,
) -> String {
    let workspace = path_string(workspace_root);
    let project = path_string(project_root);
    value
        // Match IntelliJ's `$PROJECT_DIR$` contract: it is the selected
        // project/module root. `${workspaceRoot}` is the explicit escape hatch
        // for repository/workspace-level files in a multi-project workspace.
        .replace("$PROJECT_DIR$", &project)
        .replace("${workspaceRoot}", &workspace)
        .replace("${projectRoot}", &project)
}

pub(super) fn expand_shared_value(value: &mut Value, workspace_root: &Path, project_root: &Path) {
    match value {
        Value::String(item) => {
            *item = expand_shared_string(item, workspace_root, project_root);
        }
        Value::Array(items) => {
            for item in items {
                expand_shared_value(item, workspace_root, project_root);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                expand_shared_value(item, workspace_root, project_root);
            }
        }
        _ => {}
    }
}

pub(super) fn resolve_shared_path(
    value: &str,
    workspace_root: &Path,
    project_root: &Path,
) -> String {
    let expanded = expand_shared_string(value, workspace_root, project_root);
    let path = Path::new(&expanded);
    if path.is_absolute() {
        path_string(path)
    } else {
        path_string(&project_root.join(path))
    }
}

pub(super) fn resolve_shared_executable(
    value: &str,
    workspace_root: &Path,
    project_root: &Path,
) -> String {
    let expanded = expand_shared_string(value, workspace_root, project_root);
    let path = Path::new(&expanded);
    if path.is_absolute() || expanded.contains('/') || expanded.contains('\\') {
        if path.is_absolute() {
            path_string(path)
        } else {
            path_string(&project_root.join(path))
        }
    } else {
        expanded
    }
}

pub(super) fn merge_shared_run(base: &mut SharedRunSpec, patch: SharedRunSpec) {
    if patch.executable.is_some() {
        base.executable = patch.executable;
    }
    if patch.args.is_some() {
        base.args = patch.args;
    }
    if patch.cwd.is_some() {
        base.cwd = patch.cwd;
    }
    if let Some(env) = patch.env {
        base.env.get_or_insert_with(BTreeMap::new).extend(env);
    }
    if patch.display.is_some() {
        base.display = patch.display;
    }
    if patch.runtime_options.is_some() {
        base.runtime_options = patch.runtime_options;
    }
    if patch.env_file.is_some() {
        base.env_file = patch.env_file;
    }
    if patch.argument_strategy.is_some() {
        base.argument_strategy = patch.argument_strategy;
    }
    if let Some(modes) = patch.environment_modes {
        base.environment_modes
            .get_or_insert_with(BTreeMap::new)
            .extend(modes);
    }
}

pub(super) fn merge_shared_debug(base: &mut SharedDebugSpec, patch: SharedDebugSpec) {
    if patch.adapter_id.is_some() {
        base.adapter_id = patch.adapter_id;
    }
    if patch.request.is_some() {
        base.request = patch.request;
    }
    if patch.available.is_some() {
        base.available = patch.available;
    }
    if patch.launch_config.is_some() {
        base.launch_config = patch.launch_config;
    }
    if patch.env_file.is_some() {
        base.env_file = patch.env_file;
    }
}

pub(super) fn apply_shared_platform(configuration: &mut SharedConfiguration) {
    let Some(patch) = configuration.platforms.remove(shared_platform_key()) else {
        return;
    };
    if patch.source_file.is_some() {
        configuration.source_file = patch.source_file;
    }
    if let Some(before_launch) = patch.before_launch {
        configuration.before_launch = Some(before_launch);
    }
    if patch.kind.is_some() {
        configuration.kind = patch.kind;
    }
    if let Some(run) = patch.run {
        merge_shared_run(
            configuration.run.get_or_insert_with(SharedRunSpec::default),
            run,
        );
    }
    if let Some(debug) = patch.debug {
        merge_shared_debug(
            configuration
                .debug
                .get_or_insert_with(SharedDebugSpec::default),
            debug,
        );
    }
    if patch.compound.is_some() {
        configuration.compound = patch.compound;
    }
}

pub(super) fn merge_shared_configuration_patch(
    configuration: &mut SharedConfiguration,
    patch: SharedConfigurationPatch,
) {
    if patch.source_file.is_some() {
        configuration.source_file = patch.source_file;
    }
    if patch.before_launch.is_some() {
        configuration.before_launch = patch.before_launch;
    }
    if patch.kind.is_some() {
        configuration.kind = patch.kind;
    }
    if let Some(run) = patch.run {
        merge_shared_run(
            configuration.run.get_or_insert_with(SharedRunSpec::default),
            run,
        );
    }
    if let Some(debug) = patch.debug {
        merge_shared_debug(
            configuration
                .debug
                .get_or_insert_with(SharedDebugSpec::default),
            debug,
        );
    }
    if patch.compound.is_some() {
        configuration.compound = patch.compound;
    }
}

pub(super) fn migrate_shared_file(
    mut file: SharedConfigurationFile,
) -> Result<Vec<SharedConfiguration>, String> {
    let version = file
        .version
        .unwrap_or_else(|| if file.runs.is_empty() { 2 } else { 1 });
    if version == 1 {
        if !file.configurations.is_empty() && !file.runs.is_empty() {
            return Err("version 1 cannot contain both `runs` and `configurations`".to_string());
        }
        let values = if file.runs.is_empty() {
            file.configurations
                .into_iter()
                .map(|configuration| serde_json::to_value(configuration).unwrap_or(Value::Null))
                .collect()
        } else {
            file.runs
        };
        file.configurations = values
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                let mut configuration: SharedConfiguration = serde_json::from_value(value)
                    .map_err(|error| format!("migrate v1 run at index {index}: {error}"))?;
                if configuration.run.is_none() {
                    let has_run = configuration.executable.is_some()
                        || configuration.args.is_some()
                        || configuration.cwd.is_some()
                        || configuration.env.is_some();
                    if has_run {
                        configuration.run = Some(SharedRunSpec {
                            executable: configuration.executable.take(),
                            args: configuration.args.take(),
                            cwd: configuration.cwd.take(),
                            env: configuration.env.take(),
                            display: configuration.display.take(),
                            runtime_options: configuration.runtime_options.take(),
                            env_file: configuration.env_file.take(),
                            argument_strategy: configuration.argument_strategy.take(),
                            environment_modes: configuration.environment_modes.take(),
                        });
                    }
                }
                if configuration.debug.is_none()
                    && (configuration.adapter_id.is_some() || configuration.launch_config.is_some())
                {
                    configuration.debug = Some(SharedDebugSpec {
                        adapter_id: configuration.adapter_id.take(),
                        request: configuration.request.take(),
                        launch_config: configuration.launch_config.take(),
                        ..SharedDebugSpec::default()
                    });
                }
                Ok(configuration)
            })
            .collect::<Result<Vec<_>, String>>()?;
    } else if version != SHARED_RUN_CONFIG_VERSION {
        return Err(format!(
            "unsupported version {version}; expected 1 or {SHARED_RUN_CONFIG_VERSION}"
        ));
    } else if !file.runs.is_empty() {
        return Err("version 2 uses `configurations`; remove the legacy `runs` array".to_string());
    }
    if file.configurations.is_empty() {
        return Err(
            "shared configuration file must contain at least one configuration".to_string(),
        );
    }
    validate_shared_platforms(&file.templates, "templates")?;
    for configuration in &file.configurations {
        validate_shared_platform_map(
            &configuration.platforms,
            &format!("configuration `{}`", configuration.id),
        )?;
    }
    for configuration in &mut file.configurations {
        let Some(template_id) = configuration.template.clone() else {
            continue;
        };
        let Some(template) = file.templates.get(&template_id) else {
            return Err(format!(
                "configuration `{}` references unknown template `{template_id}`",
                configuration.id
            ));
        };
        let own_patch = SharedConfigurationPatch {
            source_file: configuration.source_file.take(),
            before_launch: configuration.before_launch.take(),
            kind: configuration.kind.take(),
            run: configuration.run.take(),
            debug: configuration.debug.take(),
            compound: configuration.compound.take(),
        };
        merge_shared_configuration_patch(configuration, template.patch.clone());
        if let Some(platform) = template.platforms.get(shared_platform_key()) {
            merge_shared_configuration_patch(configuration, platform.clone());
        }
        merge_shared_configuration_patch(configuration, own_patch);
    }
    Ok(file.configurations)
}

pub(super) fn validate_shared_platform_map(
    platforms: &BTreeMap<String, SharedConfigurationPatch>,
    field: &str,
) -> Result<(), String> {
    for platform in platforms.keys() {
        if !matches!(platform.as_str(), "linux" | "macos" | "windows") {
            return Err(format!(
                "`{field}.platforms` contains unknown platform `{platform}`"
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_shared_platforms(
    templates: &BTreeMap<String, SharedTemplate>,
    field: &str,
) -> Result<(), String> {
    for (template_id, template) in templates {
        validate_shared_platform_map(
            &template.platforms,
            &format!("{field} template `{template_id}`"),
        )?;
    }
    Ok(())
}

pub(super) fn validate_shared_identifier(value: &str, field: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("`{field}` must not be empty"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("`{field}` must not contain control characters"));
    }
    Ok(())
}

pub(super) fn validate_shared_env(
    env: &BTreeMap<String, String>,
    field: &str,
) -> Result<(), String> {
    let name_pattern = Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").expect("valid env regex");
    for name in env.keys() {
        if !name_pattern.is_match(name) {
            return Err(format!(
                "`{field}` contains invalid environment name `{name}`"
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_string_list(values: &[String], field: &str) -> Result<(), String> {
    if let Some(index) = values.iter().position(|value| value.contains('\0')) {
        return Err(format!("`{field}[{index}]` contains a NUL byte"));
    }
    Ok(())
}
