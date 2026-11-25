use std::time::Instant;
use x11rb::protocol::damage;
use x11rb::protocol::xfixes;

/// XDamage tracking state. Present only when the X server advertises the DAMAGE
/// extension and we successfully created a `Damage` object on the root window.
pub(super) struct DamageState {
    pub(super) damage: damage::Damage,
    /// Pre-allocated XFixes region used as the `parts` sink for
    /// `damage_subtract` so the consume-and-read-back is atomic server-side (no
    /// lost-update race between reading a notify and clearing the damage).
    pub(super) region: xfixes::Region,
    /// When we last read pixels back, to enforce [`MIN_FRAME_INTERVAL`].
    pub(super) last_capture: Option<Instant>,
}
