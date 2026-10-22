use std::time::Duration;

pub(super) const FLOW_WAIT: Duration = Duration::from_secs(2);
pub(super) const PREPARATION_WRAPPER: &str = r#"taomni_prepare() {
  eval "$1"
}
taomni_prepare "$1"
taomni_status=$?
[ "$taomni_status" -eq 0 ] || exit "$taomni_status"
shift
exec "$@""#;
pub(super) static LAUNCHER_BYTES: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/taomni-sockscap-trace-launcher"));
