use super::*;

fn write_temp_entries(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| is_workspace_write_temp_path(name))
        .collect()
}

mod atomic_writes;
mod encoding_matrix;
mod listing_and_git_roots;
mod resources;
mod tasks_and_java;
mod text_and_encoding;
mod tool_resolution;
