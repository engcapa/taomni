mod scopes;

mod files;

mod model;

mod builder;

mod analysis;

mod version_files;

mod maven;

mod gradle;

mod standalone;

mod python;

mod requirements;

#[cfg(test)]
mod tests;

pub use model::{
    KotlinCompilerMode, KotlinPlatform, KotlinProjectProfile, ProjectBuildSystem,
    ProjectSdkProfile, SdkConfidence, SdkConstraintPolicy, SdkEvidence, SdkRequirement,
    SdkVersionConstraint, WorkspaceSdkAnalysis,
};

pub use analysis::analyze_workspace;
