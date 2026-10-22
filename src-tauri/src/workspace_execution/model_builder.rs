use super::*;

impl ModelBuilder {
    pub(super) fn finish(mut self) -> WorkspaceExecutionModel {
        self.resolve_module_hierarchy();
        self.projects.sort_by(|a, b| a.id.cmp(&b.id));
        self.modules.sort_by(|a, b| a.id.cmp(&b.id));
        self.source_sets.sort_by(|a, b| a.id.cmp(&b.id));
        self.build_targets.sort_by(|a, b| a.id.cmp(&b.id));
        self.compile_artifacts.sort_by(|a, b| a.id.cmp(&b.id));
        self.run_configurations.sort_by(|a, b| a.id.cmp(&b.id));
        self.debug_configurations.sort_by(|a, b| a.id.cmp(&b.id));
        self.diagnostics.sort();
        self.diagnostics.dedup();
        WorkspaceExecutionModel {
            projects: self.projects,
            modules: self.modules,
            source_sets: self.source_sets,
            build_targets: self.build_targets,
            compile_artifacts: self.compile_artifacts,
            run_configurations: self.run_configurations,
            debug_configurations: self.debug_configurations,
            tools: self.tools.into_values().collect(),
            diagnostics: self.diagnostics,
        }
    }

    pub(super) fn resolve_module_hierarchy(&mut self) {
        let mut parent_to_children: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut child_to_parent: BTreeMap<String, String> = BTreeMap::new();
        let mut module_deps: BTreeMap<String, Vec<String>> = BTreeMap::new();

        // 1. Maven hierarchy from pom.xml <modules>
        for module in &self.modules {
            let manifest_path = Path::new(&module.manifest);
            if manifest_path.file_name().and_then(|v| v.to_str()) == Some("pom.xml") {
                if let Ok(content) = fs::read_to_string(manifest_path) {
                    let submodules = parse_maven_modules(&content);
                    let module_root = Path::new(&module.root);
                    for sub in submodules {
                        let sub_root = module_root.join(&sub);
                        let sub_root_str = path_string(&sub_root);
                        if let Some(child) = self.modules.iter().find(|m| m.root == sub_root_str) {
                            parent_to_children
                                .entry(module.id.clone())
                                .or_default()
                                .push(child.id.clone());
                            child_to_parent.insert(child.id.clone(), module.id.clone());
                        }
                    }
                }
            }
        }

        // 2. Gradle hierarchy from settings.gradle / settings.gradle.kts
        for module in &self.modules {
            let module_root = Path::new(&module.root);
            for settings_name in ["settings.gradle", "settings.gradle.kts"] {
                let settings_path = module_root.join(settings_name);
                if settings_path.is_file() {
                    if let Ok(content) = fs::read_to_string(&settings_path) {
                        let submodules = parse_gradle_settings_modules(&content);
                        for sub in submodules {
                            let sub_root = module_root.join(&sub);
                            let sub_root_str = path_string(&sub_root);
                            if let Some(child) =
                                self.modules.iter().find(|m| m.root == sub_root_str)
                            {
                                parent_to_children
                                    .entry(module.id.clone())
                                    .or_default()
                                    .push(child.id.clone());
                                child_to_parent.insert(child.id.clone(), module.id.clone());
                            }
                        }
                    }
                }
            }
        }

        // 3. Module dependencies from build.gradle / build.gradle.kts
        for module in &self.modules {
            let manifest_path = Path::new(&module.manifest);
            if let Ok(content) = fs::read_to_string(manifest_path) {
                let deps = parse_gradle_project_dependencies(&content);
                if !deps.is_empty() {
                    module_deps.insert(module.id.clone(), deps);
                }
            }
        }

        // Apply to self.modules
        for module in &mut self.modules {
            if let Some(parent_id) = child_to_parent.get(&module.id) {
                module.parent_module_id = Some(parent_id.clone());
            }
            if let Some(mut children) = parent_to_children.remove(&module.id) {
                children.sort();
                children.dedup();
                module.child_module_ids = children;
            }
            if let Some(mut deps) = module_deps.remove(&module.id) {
                deps.sort();
                deps.dedup();
                module.module_dependencies = deps;
            }
        }
    }

    pub(super) fn tool(
        &mut self,
        root: &Path,
        config: Option<&WorkspaceToolConfig>,
        id: &str,
        label: &str,
        wrappers: &[&str],
        candidates: &[&str],
        install_hint: &str,
    ) -> ToolProbe {
        let cache_key = format!("{}\0{}", path_string(root), id);
        if let Some(existing) = self.tools.get(&cache_key) {
            return existing.clone();
        }
        let configured = configured_tool(config, id);
        let probe = resolve_tool(
            root,
            id,
            label,
            configured,
            wrappers,
            candidates,
            install_hint,
        );
        self.tools.insert(cache_key, probe.clone());
        probe
    }

    pub(super) fn project(
        &mut self,
        provider: &str,
        manifest: &Path,
        languages: &[&str],
        toolchain: &str,
    ) -> ProjectModel {
        let root = manifest.parent().unwrap_or(manifest);
        let id = stable_id("project", &[provider, &path_string(manifest)]);
        let module_id = stable_id("module", &[&id, &path_string(root)]);
        let project = ProjectModel {
            id,
            provider: provider.to_string(),
            root: path_string(root),
            manifest: path_string(manifest),
            module: root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("project")
                .to_string(),
            module_id,
            languages: languages.iter().map(|value| (*value).to_string()).collect(),
            language_level: detect_language_level(provider, manifest),
            toolchain: toolchain.to_string(),
            diagnostics: Vec::new(),
        };
        self.register_project(project)
    }

    pub(super) fn register_project(&mut self, project: ProjectModel) -> ProjectModel {
        if let Some(existing) = self.projects.iter().find(|entry| entry.id == project.id) {
            return existing.clone();
        }
        let source_sets = discover_source_sets(&project);
        let source_set_ids = source_sets
            .iter()
            .map(|source_set| source_set.id.clone())
            .collect();
        self.modules.push(ModuleModel {
            id: project.module_id.clone(),
            project_id: project.id.clone(),
            name: project.module.clone(),
            root: project.root.clone(),
            manifest: project.manifest.clone(),
            language_level: project.language_level.clone(),
            source_set_ids,
            parent_module_id: None,
            child_module_ids: Vec::new(),
            module_dependencies: Vec::new(),
            diagnostics: Vec::new(),
        });
        self.source_sets.extend(source_sets);
        self.projects.push(project.clone());
        project
    }

    pub(super) fn build(
        &mut self,
        project: &ProjectModel,
        label: &str,
        kind: &str,
        command: ExecutionCommand,
    ) -> String {
        let id = stable_id("build", &[&project.id, kind, label]);
        let artifact_ids = if kind == "build" {
            let artifact_id = stable_id("artifact", &[&id, &project.module_id, label]);
            let root = Path::new(&project.root);
            let (path, resolution, diagnostic) = if let Some(resolved) =
                resolve_existing_artifact_path(root, &project.provider, label)
            {
                (Some(path_string(&resolved)), "resolved".to_string(), None)
            } else if command.error.is_some() {
                (None, "blocked".to_string(), command.error.clone())
            } else {
                (
                    None,
                    "pending-provider-output".to_string(),
                    Some(compile_artifact_diagnostic(&project.provider).to_string()),
                )
            };
            self.compile_artifacts.push(CompileArtifact {
                id: artifact_id.clone(),
                project_id: project.id.clone(),
                module_id: project.module_id.clone(),
                target_id: id.clone(),
                kind: compile_artifact_kind(&project.provider, label).to_string(),
                path,
                resolution,
                source: "build-target".to_string(),
                diagnostic,
            });
            vec![artifact_id]
        } else {
            Vec::new()
        };
        self.build_targets.push(BuildTarget {
            id: id.clone(),
            project_id: project.id.clone(),
            module_id: project.module_id.clone(),
            label: label.to_string(),
            kind: kind.to_string(),
            command,
            depends_on: Vec::new(),
            artifact_ids,
        });
        id
    }

    pub(super) fn debug(
        &mut self,
        project: &ProjectModel,
        label: &str,
        adapter_id: &str,
        adapter: &ToolProbe,
        pre_launch_targets: Vec<String>,
        source_file: Option<String>,
        arguments: Value,
        mode: Option<Value>,
    ) -> String {
        let id = stable_id("debug", &[&project.id, adapter_id, label]);
        let diagnostic = if adapter.state == "available" {
            None
        } else {
            Some(format!(
                "{} is unavailable. {}",
                adapter.label, adapter.install_hint
            ))
        };
        let mut launch_config = json!({
            "adapterCommand": adapter.executable,
            "adapterCwd": project.root,
            "request": "launch",
            "arguments": arguments,
        });
        if let Some(mode) = mode {
            launch_config["mode"] = mode;
        }
        self.debug_configurations.push(DebugConfiguration {
            id: id.clone(),
            project_id: project.id.clone(),
            label: label.to_string(),
            adapter_id: adapter_id.to_string(),
            request: "launch".to_string(),
            available: diagnostic.is_none(),
            diagnostic,
            pre_launch_targets,
            source_file,
            launch_config,
            env_file: None,
            configuration_source: Some("provider".to_string()),
            compound_configuration_ids: None,
            compound_parallel: None,
            compound_stop_on_failure: None,
        });
        id
    }

    pub(super) fn run(
        &mut self,
        project: &ProjectModel,
        label: &str,
        kind: &str,
        command: ExecutionCommand,
        source_file: Option<String>,
        pre_launch_targets: Vec<String>,
        debug_configuration_id: Option<String>,
    ) {
        self.run_configurations.push(RunConfiguration {
            id: stable_id(
                "run",
                &[
                    &project.id,
                    kind,
                    label,
                    source_file.as_deref().unwrap_or(""),
                ],
            ),
            project_id: project.id.clone(),
            label: label.to_string(),
            kind: kind.to_string(),
            command,
            source_file,
            pre_launch_targets,
            debug_configuration_id,
            configuration_source: Some("provider".to_string()),
            runtime_options: None,
            env_file: None,
            argument_strategy: None,
            environment_modes: None,
            compound_configuration_ids: None,
            compound_parallel: None,
            compound_stop_on_failure: None,
        });
    }
}
