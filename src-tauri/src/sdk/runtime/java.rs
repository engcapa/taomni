use super::model::JavaRuntimeConfiguration;
use super::paths::paths_equal;
use super::paths::sdk_home;
use crate::sdk::SdkInstallation;
use crate::sdk::SdkKind;
use crate::sdk::SdkRegistry;
use crate::sdk::SdkStatus;
use std::collections::HashSet;

pub(super) fn java_runtime_configurations(
    registry: &SdkRegistry,
    project_java: Option<&SdkInstallation>,
) -> Vec<JavaRuntimeConfiguration> {
    let default_java = registry
        .defaults
        .iter()
        .find(|entry| entry.kind == SdkKind::Java)
        .map(|entry| entry.sdk_id.as_str());
    let mut candidates = registry
        .installations
        .iter()
        .filter(|sdk| sdk.kind == SdkKind::Java && sdk.status == SdkStatus::Ready)
        .cloned()
        .collect::<Vec<_>>();
    if let Some(project_java) = project_java
        && !candidates
            .iter()
            .any(|sdk| paths_equal(&sdk.location, &project_java.location))
    {
        candidates.push(project_java.clone());
    }
    candidates.sort_by(|left, right| {
        let left_project =
            project_java.is_some_and(|sdk| paths_equal(&sdk.location, &left.location));
        let right_project =
            project_java.is_some_and(|sdk| paths_equal(&sdk.location, &right.location));
        let left_default = default_java == Some(left.id.as_str());
        let right_default = default_java == Some(right.id.as_str());
        right_project
            .cmp(&left_project)
            .then_with(|| right_default.cmp(&left_default))
            .then_with(|| left.name.cmp(&right.name))
    });

    let mut seen_majors = HashSet::new();
    let mut runtimes = Vec::new();
    for sdk in candidates {
        let Some(major) = sdk.version.as_deref().and_then(java_major) else {
            continue;
        };
        if !seen_majors.insert(major) {
            continue;
        }
        runtimes.push(JavaRuntimeConfiguration {
            name: if major == 8 {
                "JavaSE-1.8".to_string()
            } else {
                format!("JavaSE-{major}")
            },
            // jdtls writes this into runtime configs; keep it a plain path.
            path: sdk_home(&sdk),
            default: project_java
                .is_some_and(|project| paths_equal(&project.location, &sdk.location)),
        });
    }
    runtimes.sort_by_key(|runtime| runtime.name.clone());
    runtimes
}

pub(super) fn java_major(value: &str) -> Option<u32> {
    let numbers = value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .collect::<Vec<_>>();
    match numbers.as_slice() {
        [1, major, ..] => Some(*major),
        [major, ..] => Some(*major),
        [] => None,
    }
}
