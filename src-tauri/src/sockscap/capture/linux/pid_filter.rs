//! PID filtering for Linux capture plane.

pub fn pid_filter(pid: u32, target_pid: Option<u32>) -> bool {
    target_pid.map_or(true, |tp| pid == tp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pid_filter() {
        assert!(pid_filter(1234, Some(1234)));
        assert!(!pid_filter(1234, Some(5678)));
        assert!(pid_filter(1234, None));
    }
}