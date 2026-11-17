use super::StillError;

pub(super) struct LumaBudget {
    remaining: usize,
    limited: bool,
}

impl LumaBudget {
    pub fn new(bytes: usize) -> Self {
        Self {
            remaining: bytes,
            limited: bytes != usize::MAX,
        }
    }
    pub fn is_bounded(&self) -> bool {
        self.limited
    }
    pub fn check(&self, width: u32, height: u32) -> Result<usize, StillError> {
        (width as usize)
            .checked_mul(height as usize)
            .filter(|size| width > 0 && height > 0 && *size <= self.remaining)
            .ok_or_else(|| StillError::Failed("capture exceeds luma byte budget".into()))
    }
    pub fn account(&mut self, width: u32, height: u32) -> Result<(), StillError> {
        self.remaining -= self.check(width, height)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_and_aggregate_are_bounded_before_pixel_conversion() {
        let mut budget = LumaBudget::new(12);
        budget.account(3, 2).unwrap();
        assert!(budget.check(7, 1).is_err());
        assert!(budget.check(0, 1).is_err());
        assert!(budget.check(u32::MAX, u32::MAX).is_err());
        budget.account(3, 2).unwrap();
        assert!(budget.check(1, 1).is_err());
    }
}
