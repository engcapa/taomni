use super::analysis::analyze_workspace;
use super::files::path_string;
use super::model::KotlinPlatform;
use super::model::ProjectSdkProfile;
use super::model::SdkConstraintPolicy;
use super::model::SdkRequirement;
use crate::sdk::SdkKind;
use crate::sdk::SdkRole;
use std::path::Path;

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, contents).unwrap();
}

fn requirement_for(profile: &ProjectSdkProfile, kind: SdkKind, role: SdkRole) -> &SdkRequirement {
    profile
        .requirements
        .iter()
        .find(|requirement| requirement.kind == kind && requirement.role == role)
        .unwrap()
}

#[test]
fn detects_maven_java_and_kotlin_without_treating_jvm_target_as_jdk() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("pom.xml"),
        r#"<project>
              <properties>
                <kotlin.version>2.1.20</kotlin.version>
                <kotlin.compiler.languageVersion>2.1</kotlin.compiler.languageVersion>
                <kotlin.compiler.apiVersion>2.0</kotlin.compiler.apiVersion>
                <maven.compiler.release>17</maven.compiler.release>
                <kotlin.compiler.jvmTarget>8</kotlin.compiler.jvmTarget>
              </properties>
              <build><plugins><plugin>
                <artifactId>kotlin-maven-plugin</artifactId>
                <version>${kotlin.version}</version>
              </plugin></plugins></build>
            </project>"#,
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let profile = &analysis.profiles[0];
    let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
    assert_eq!(
        java.constraint.as_ref().and_then(|value| value.major),
        Some(17)
    );
    let kotlin = profile.kotlin.as_ref().unwrap();
    assert_eq!(kotlin.compiler_version.as_deref(), Some("2.1.20"));
    assert_eq!(kotlin.language_version.as_deref(), Some("2.1"));
    assert_eq!(kotlin.api_version.as_deref(), Some("2.0"));
    assert_eq!(kotlin.jvm_target.as_deref(), Some("8"));
    assert!(requirement_for(profile, SdkKind::Kotlin, SdkRole::Compiler).managed_by_build);
}

#[test]
fn treats_maven_jdk_toolchain_as_an_exact_major() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("pom.xml"),
        r#"<project><build><plugins><plugin>
              <artifactId>maven-compiler-plugin</artifactId>
              <configuration><jdkToolchain><version>17</version></jdkToolchain></configuration>
            </plugin></plugins></build></project>"#,
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let java = requirement_for(&analysis.profiles[0], SdkKind::Java, SdkRole::Project);
    assert_eq!(
        java.constraint.as_ref().unwrap().policy,
        SdkConstraintPolicy::ExactMajor
    );
    assert_eq!(java.constraint.as_ref().unwrap().major, Some(17));
}

#[test]
fn detects_gradle_kotlin_toolchain_and_version_catalog() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("build.gradle.kts"),
        r#"plugins { alias(libs.plugins.kotlin.jvm) }
               kotlin { jvmToolchain(17) }
               kotlin { compilerOptions {
                 languageVersion.set(KotlinVersion.KOTLIN_2_1)
                 apiVersion.set(KotlinVersion.KOTLIN_2_0)
                 jvmTarget.set(JvmTarget.JVM_8)
               } }"#,
    );
    write(
        &directory.path().join("gradle.properties"),
        "org.gradle.java.home=/opt/jdk-21\n",
    );
    write(
        &directory.path().join("gradle/libs.versions.toml"),
        r#"[versions]
               kotlin = "2.2.0"
               [plugins]
               kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }"#,
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let profile = &analysis.profiles[0];
    let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
    assert_eq!(
        java.constraint.as_ref().unwrap().policy,
        SdkConstraintPolicy::ExactMajor
    );
    assert_eq!(java.constraint.as_ref().unwrap().major, Some(17));
    let kotlin = profile.kotlin.as_ref().unwrap();
    assert_eq!(kotlin.compiler_version.as_deref(), Some("2.2.0"));
    assert_eq!(kotlin.language_version.as_deref(), Some("2.1"));
    assert_eq!(kotlin.api_version.as_deref(), Some("2.0"));
    assert_eq!(kotlin.jvm_target.as_deref(), Some("8"));
    assert_eq!(kotlin.java_toolchain.as_deref(), Some("17"));
    assert_eq!(
        kotlin.gradle_launcher_java_home.as_deref(),
        Some("/opt/jdk-21")
    );
}

#[test]
fn ignores_unused_kotlin_version_hints() {
    let maven = tempfile::tempdir().unwrap();
    write(
        &maven.path().join("pom.xml"),
        r#"<project><properties>
              <java.version>21</java.version>
              <kotlin.version>2.2.0</kotlin.version>
            </properties></project>"#,
    );
    let analysis = analyze_workspace(&path_string(maven.path())).unwrap();
    let profile = &analysis.profiles[0];
    assert!(!profile.languages.contains(&SdkKind::Kotlin));
    assert!(profile.kotlin.is_none());

    let gradle = tempfile::tempdir().unwrap();
    write(
        &gradle.path().join("build.gradle.kts"),
        "plugins { java }\njava { toolchain.languageVersion.set(JavaLanguageVersion.of(21)) }\n",
    );
    write(
        &gradle.path().join("gradle/libs.versions.toml"),
        r#"[versions]
              kotlin = "2.2.0"
              [plugins]
              kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }"#,
    );
    let analysis = analyze_workspace(&path_string(gradle.path())).unwrap();
    let profile = &analysis.profiles[0];
    assert!(!profile.languages.contains(&SdkKind::Kotlin));
    assert!(profile.kotlin.is_none());
}

#[test]
fn detects_bare_gradle_java_plugin_and_toolchain() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("build.gradle.kts"),
        "plugins { java }\njava { toolchain.languageVersion.set(JavaLanguageVersion.of(17)) }\n",
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let profile = &analysis.profiles[0];
    assert!(profile.languages.contains(&SdkKind::Java));
    let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
    assert_eq!(
        java.constraint.as_ref().unwrap().policy,
        SdkConstraintPolicy::ExactMajor
    );
    assert_eq!(java.constraint.as_ref().unwrap().major, Some(17));
}

#[test]
fn maven_scala_sources_require_java_without_an_explicit_plugin_version() {
    let directory = tempfile::tempdir().unwrap();
    write(&directory.path().join("pom.xml"), "<project />");
    write(
        &directory.path().join("src/main/scala/App.scala"),
        "object App extends App {}\n",
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let profile = &analysis.profiles[0];
    assert!(profile.languages.contains(&SdkKind::Scala));
    assert!(requirement_for(profile, SdkKind::Scala, SdkRole::Compiler).managed_by_build);
    let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
    assert!(java.constraint.is_none());
}

#[test]
fn detects_python_range_and_project_virtual_environment() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(".venv")).unwrap();
    write(
        &directory.path().join("pyproject.toml"),
        "[project]\nrequires-python = '>=3.11,<3.14'\n",
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let python = requirement_for(&analysis.profiles[0], SdkKind::Python, SdkRole::Project);
    assert_eq!(
        python.constraint.as_ref().unwrap().policy,
        SdkConstraintPolicy::Range
    );
    assert!(
        python
            .required_location
            .as_deref()
            .unwrap()
            .ends_with(".venv")
    );
}

#[test]
fn detects_sbt_compiler_as_build_managed_and_jdk_release_separately() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("build.sbt"),
        r#"ThisBuild / scalaVersion := "3.6.4"
               javacOptions ++= Seq("--release", "21")"#,
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let profile = &analysis.profiles[0];
    let scala = requirement_for(profile, SdkKind::Scala, SdkRole::Compiler);
    assert!(scala.managed_by_build);
    assert_eq!(scala.constraint.as_ref().unwrap().raw, "3.6.4");
    let java = requirement_for(profile, SdkKind::Java, SdkRole::Project);
    assert_eq!(java.constraint.as_ref().unwrap().major, Some(21));
}

#[test]
fn keeps_kmp_targets_from_creating_jdk_requirement_without_jvm_toolchain() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("build.gradle.kts"),
        r#"plugins { kotlin("multiplatform") version "2.2.0" }
               kotlin { js(); linuxX64() }"#,
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let profile = &analysis.profiles[0];
    assert_eq!(
        profile.kotlin.as_ref().unwrap().platform,
        KotlinPlatform::Multiplatform
    );
    assert!(
        !profile
            .requirements
            .iter()
            .any(|requirement| requirement.kind == SdkKind::Java)
    );
}

#[test]
fn detects_kotlin_platform_from_an_applied_catalog_alias() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("build.gradle.kts"),
        r#"plugins { alias(libs.plugins.kotlin.multiplatform) }
               kotlin { js(); linuxX64() }"#,
    );
    write(
        &directory.path().join("gradle/libs.versions.toml"),
        r#"[versions]
               kotlin = "2.2.0"
               [plugins]
               kotlin-multiplatform = { id = "org.jetbrains.kotlin.multiplatform", version.ref = "kotlin" }"#,
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    let profile = &analysis.profiles[0];
    let kotlin = profile.kotlin.as_ref().unwrap();
    assert_eq!(kotlin.platform, KotlinPlatform::Multiplatform);
    assert_eq!(kotlin.compiler_version.as_deref(), Some("2.2.0"));
    assert!(
        !profile
            .requirements
            .iter()
            .any(|requirement| requirement.kind == SdkKind::Java)
    );
}

#[test]
fn discovers_nested_module_profiles_without_scanning_dependency_directories() {
    let directory = tempfile::tempdir().unwrap();
    write(&directory.path().join("pom.xml"), "<project />");
    write(
        &directory.path().join("service/.python-version"),
        "3.12.2\n",
    );
    write(
        &directory
            .path()
            .join("node_modules/ignored/.python-version"),
        "2.7\n",
    );

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    assert!(
        analysis
            .profiles
            .iter()
            .any(|profile| profile.relative_path.ends_with("service"))
    );
    assert!(
        !analysis
            .profiles
            .iter()
            .any(|profile| profile.relative_path.contains("node_modules"))
    );
}

#[test]
fn standalone_root_does_not_duplicate_nested_project_sources() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("service/.python-version"),
        "3.12.2\n",
    );
    write(&directory.path().join("service/main.py"), "print('ok')\n");

    let analysis = analyze_workspace(&path_string(directory.path())).unwrap();
    assert_eq!(analysis.profiles.len(), 1);
    assert!(analysis.profiles[0].relative_path.ends_with("service"));
}
