use enigo::Button;
use enigo::Direction;
use enigo::Direction::Press;
use enigo::Direction::Release;
use enigo::Mouse;
#[cfg(target_os = "macos")]
use ironrdp::server::DesktopSize;
#[cfg(target_os = "macos")]
use objc2_core_foundation::CFRetained;
#[cfg(target_os = "macos")]
use objc2_core_foundation::CGPoint;
#[cfg(target_os = "macos")]
use objc2_core_graphics::CGEvent;
#[cfg(target_os = "macos")]
use objc2_core_graphics::CGEventField;
#[cfg(target_os = "macos")]
use objc2_core_graphics::CGEventSource;
#[cfg(target_os = "macos")]
use objc2_core_graphics::CGEventSourceStateID;
#[cfg(target_os = "macos")]
use objc2_core_graphics::CGEventTapLocation;
#[cfg(target_os = "macos")]
use objc2_core_graphics::CGEventType;
#[cfg(target_os = "macos")]
use objc2_core_graphics::CGMouseButton;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU32;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
use std::time::Instant;

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
pub(crate) struct MacInputMapping {
    pub(super) origin_x: f64,
    pub(super) origin_y: f64,
    pub(super) logical_width: f64,
    pub(super) logical_height: f64,
    pub(super) surface_size: Arc<AtomicU32>,
}

#[cfg(target_os = "macos")]
impl MacInputMapping {
    pub(crate) fn new(
        bounds: super::super::capture::mac::DisplayBounds,
        surface_size: Arc<AtomicU32>,
    ) -> anyhow::Result<Self> {
        if bounds.width == 0 || bounds.height == 0 {
            anyhow::bail!("selected display has invalid logical bounds");
        }
        let surface = unpack_surface_size(surface_size.load(Ordering::Relaxed));
        if surface.width == 0 || surface.height == 0 {
            anyhow::bail!("RDP input surface has invalid dimensions");
        }
        Ok(Self {
            origin_x: f64::from(bounds.x),
            origin_y: f64::from(bounds.y),
            logical_width: f64::from(bounds.width),
            logical_height: f64::from(bounds.height),
            surface_size,
        })
    }

    pub(super) fn absolute_point(&self, x: u16, y: u16) -> CGPoint {
        let surface = unpack_surface_size(self.surface_size.load(Ordering::Relaxed));
        CGPoint {
            x: map_surface_coordinate(x, surface.width, self.origin_x, self.logical_width),
            y: map_surface_coordinate(y, surface.height, self.origin_y, self.logical_height),
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn unpack_surface_size(packed: u32) -> DesktopSize {
    DesktopSize {
        width: (packed >> 16) as u16,
        height: packed as u16,
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn map_surface_coordinate(
    value: u16,
    surface_extent: u16,
    origin: f64,
    logical_extent: f64,
) -> f64 {
    let clamped = value.min(surface_extent.saturating_sub(1));
    origin + f64::from(clamped) * logical_extent / f64::from(surface_extent)
}

#[cfg(target_os = "macos")]
pub(super) struct MacMouse {
    pub(super) source: CFRetained<CGEventSource>,
    pub(super) mapping: MacInputMapping,
    pub(super) pressed: [bool; 3],
    pub(super) clicks: [ClickState; 3],
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Default)]
pub(super) struct ClickState {
    pub(super) last_press: Option<Instant>,
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) count: i64,
}

#[cfg(target_os = "macos")]
impl MacMouse {
    pub(super) fn new(mapping: MacInputMapping) -> Result<Self, String> {
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .ok_or_else(|| "could not create CoreGraphics input event source".to_string())?;
        Ok(Self {
            source,
            mapping,
            pressed: [false; 3],
            clicks: [ClickState::default(); 3],
        })
    }

    pub(super) fn current_point(&self) -> Result<CGPoint, String> {
        let event = CGEvent::new(Some(&self.source))
            .ok_or_else(|| "could not read the current macOS pointer position".to_string())?;
        Ok(CGEvent::location(Some(&event)))
    }

    pub(super) fn absolute_move(&mut self, x: u16, y: u16) -> Result<(), String> {
        let target = self.mapping.absolute_point(x, y);
        self.post_move(target)
    }

    pub(super) fn relative_move(&mut self, x: i32, y: i32) -> Result<(), String> {
        let current = self.current_point()?;
        self.post_move(CGPoint {
            x: current.x + f64::from(x),
            y: current.y + f64::from(y),
        })
    }

    pub(super) fn post_move(&mut self, target: CGPoint) -> Result<(), String> {
        let current = self.current_point()?;
        let (event_type, button) = if self.pressed[0] {
            (CGEventType::LeftMouseDragged, CGMouseButton::Left)
        } else if self.pressed[1] {
            (CGEventType::RightMouseDragged, CGMouseButton::Right)
        } else if self.pressed[2] {
            (CGEventType::OtherMouseDragged, CGMouseButton::Center)
        } else {
            (CGEventType::MouseMoved, CGMouseButton::Left)
        };
        let event = CGEvent::new_mouse_event(Some(&self.source), event_type, target, button)
            .ok_or_else(|| "could not create macOS pointer movement event".to_string())?;
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventDeltaX,
            (target.x - current.x).round() as i64,
        );
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventDeltaY,
            (target.y - current.y).round() as i64,
        );
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        Ok(())
    }

    pub(super) fn button(&mut self, button: Button, direction: Direction) -> Result<(), String> {
        if direction == Direction::Click {
            self.button(button, Direction::Press)?;
            return self.button(button, Direction::Release);
        }
        let (index, cg_button, down_type, up_type) = match button {
            Button::Left => (
                0,
                CGMouseButton::Left,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
            ),
            Button::Right => (
                1,
                CGMouseButton::Right,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
            ),
            Button::Middle => (
                2,
                CGMouseButton::Center,
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
            ),
            _ => return Err("unsupported macOS pointer button".to_string()),
        };
        let point = self.current_point()?;
        let pressed = direction == Direction::Press;
        let click_count = if pressed {
            let state = &mut self.clicks[index];
            let repeated = state.last_press.is_some_and(|last| {
                last.elapsed() <= std::time::Duration::from_millis(500)
                    && (state.x - point.x).abs() <= 4.0
                    && (state.y - point.y).abs() <= 4.0
            });
            state.count = if repeated {
                state.count.saturating_add(1)
            } else {
                1
            };
            state.last_press = Some(Instant::now());
            state.x = point.x;
            state.y = point.y;
            state.count
        } else {
            self.clicks[index].count.max(1)
        };
        let event = CGEvent::new_mouse_event(
            Some(&self.source),
            if pressed { down_type } else { up_type },
            point,
            cg_button,
        )
        .ok_or_else(|| "could not create macOS pointer button event".to_string())?;
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventClickState,
            click_count,
        );
        if index == 2 {
            CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventButtonNumber, 2);
        }
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        self.pressed[index] = pressed;
        Ok(())
    }
}
