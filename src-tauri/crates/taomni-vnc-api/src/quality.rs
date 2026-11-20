use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VncPictureQuality {
    #[default]
    Automatic,
    High,
    Medium,
    Low,
}

impl VncPictureQuality {
    pub fn from_wire(value: u8) -> Option<Self> {
        Some(match value {
            0 => Self::Automatic,
            1 => Self::High,
            2 => Self::Medium,
            3 => Self::Low,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}
