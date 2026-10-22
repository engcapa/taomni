//! RFB pixel formats and conversion to the RGBA framebuffer.
//!
//! The session normally negotiates [`PixelFormat::RGB888`], whose little-endian
//! bytes are already `R, G, B, x`, so decoders copy pixels verbatim. Reduced
//! colour levels (VNC-PERF-004 Picture quality on servers without Tight) use
//! 8- or 16-bit true-colour formats; those pixels go through a lookup table.

/// An RFB PIXEL_FORMAT (RFC 6143 §7.4). Only true-colour formats are
/// requested by Taomni; colour-map formats are never negotiated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelFormat {
    pub bits_per_pixel: u8,
    pub depth: u8,
    pub big_endian: bool,
    pub red_max: u16,
    pub green_max: u16,
    pub blue_max: u16,
    pub red_shift: u8,
    pub green_shift: u8,
    pub blue_shift: u8,
}

impl PixelFormat {
    /// 32 bpp, depth 24, little-endian, R at byte 0: the framebuffer layout.
    pub const RGB888: Self = Self {
        bits_per_pixel: 32,
        depth: 24,
        big_endian: false,
        red_max: 255,
        green_max: 255,
        blue_max: 255,
        red_shift: 0,
        green_shift: 8,
        blue_shift: 16,
    };
    /// 16 bpp, 65 536 colours.
    pub const RGB565: Self = Self {
        bits_per_pixel: 16,
        depth: 16,
        big_endian: false,
        red_max: 31,
        green_max: 63,
        blue_max: 31,
        red_shift: 11,
        green_shift: 5,
        blue_shift: 0,
    };
    /// 8 bpp, 64 colours (RealVNC `ColorLevel=rgb222`).
    pub const RGB222: Self = Self {
        bits_per_pixel: 8,
        depth: 6,
        big_endian: false,
        red_max: 3,
        green_max: 3,
        blue_max: 3,
        red_shift: 4,
        green_shift: 2,
        blue_shift: 0,
    };
    /// 8 bpp, 8 colours (RealVNC `ColorLevel=rgb111`).
    pub const RGB111: Self = Self {
        bits_per_pixel: 8,
        depth: 3,
        big_endian: false,
        red_max: 1,
        green_max: 1,
        blue_max: 1,
        red_shift: 2,
        green_shift: 1,
        blue_shift: 0,
    };

    pub fn bytes_per_pixel(&self) -> usize {
        usize::from(self.bits_per_pixel / 8)
    }

    /// True when a PIXEL is byte-for-byte an RGBA framebuffer pixel (alpha
    /// excepted), so decoders may copy instead of converting.
    pub fn is_native_rgba(&self) -> bool {
        *self == Self::RGB888
    }

    fn colour_bits(&self) -> u32 {
        (u32::from(self.red_max) << self.red_shift)
            | (u32::from(self.green_max) << self.green_shift)
            | (u32::from(self.blue_max) << self.blue_shift)
    }

    /// ZRLE CPIXEL: 3 bytes for 32 bpp formats whose colour bits fit in the
    /// low or high three bytes, otherwise a full PIXEL (RFC 6143 §7.7.6).
    pub fn cpixel_bytes(&self) -> usize {
        if self.bits_per_pixel == 32 && self.depth <= 24 {
            let bits = self.colour_bits();
            if bits & 0xFF00_0000 == 0 || bits & 0x0000_00FF == 0 {
                return 3;
            }
        }
        self.bytes_per_pixel()
    }

    /// Tight TPIXEL: `R, G, B` bytes for 32 bpp depth-24 formats with 8-bit
    /// channels, otherwise a full PIXEL.
    pub fn tpixel_is_rgb(&self) -> bool {
        self.bits_per_pixel == 32
            && self.depth == 24
            && self.red_max == 255
            && self.green_max == 255
            && self.blue_max == 255
    }

    /// The 16-byte PIXEL_FORMAT body of a SetPixelFormat message.
    pub fn to_wire(&self) -> [u8; 16] {
        let mut out = [0u8; 16];
        out[0] = self.bits_per_pixel;
        out[1] = self.depth;
        out[2] = u8::from(self.big_endian);
        out[3] = 1; // true colour
        out[4..6].copy_from_slice(&self.red_max.to_be_bytes());
        out[6..8].copy_from_slice(&self.green_max.to_be_bytes());
        out[8..10].copy_from_slice(&self.blue_max.to_be_bytes());
        out[10] = self.red_shift;
        out[11] = self.green_shift;
        out[12] = self.blue_shift;
        out
    }

    /// Session Information label in RealVNC's wording, e.g.
    /// `depth 24 (32 bpp) little-endian rgb888`.
    pub fn label(&self) -> String {
        let bits = |max: u16| 16 - max.leading_zeros();
        format!(
            "depth {} ({} bpp) {}-endian rgb{}{}{}",
            self.depth,
            self.bits_per_pixel,
            if self.big_endian { "big" } else { "little" },
            bits(self.red_max),
            bits(self.green_max),
            bits(self.blue_max),
        )
    }

    fn scale(value: u32, max: u16) -> u8 {
        if max == 0 {
            return 0;
        }
        ((value.min(u32::from(max)) * 255 + u32::from(max) / 2) / u32::from(max)) as u8
    }

    /// Convert a pixel value (already assembled from its bytes) to RGBA.
    pub fn value_to_rgba(&self, value: u32) -> [u8; 4] {
        [
            Self::scale(
                (value >> self.red_shift) & u32::from(self.red_max),
                self.red_max,
            ),
            Self::scale(
                (value >> self.green_shift) & u32::from(self.green_max),
                self.green_max,
            ),
            Self::scale(
                (value >> self.blue_shift) & u32::from(self.blue_max),
                self.blue_max,
            ),
            255,
        ]
    }
}

/// Converts wire pixels of one negotiated format to RGBA.
#[derive(Debug, Clone)]
pub struct PixelConverter {
    format: PixelFormat,
    /// Lookup table for 8/16 bpp formats (256 or 65 536 entries).
    lut: Vec<[u8; 4]>,
    // Cached per format: decoders query these per pixel or per run.
    native: bool,
    bytes_per_pixel: usize,
    cpixel_bytes: usize,
    cpixel_high: bool,
}

impl PixelConverter {
    pub fn new(format: PixelFormat) -> Self {
        let lut = match format.bits_per_pixel {
            8 => (0u32..256).map(|v| format.value_to_rgba(v)).collect(),
            16 => (0u32..65_536).map(|v| format.value_to_rgba(v)).collect(),
            _ => Vec::new(),
        };
        Self {
            format,
            lut,
            native: format.is_native_rgba(),
            bytes_per_pixel: format.bytes_per_pixel(),
            cpixel_bytes: format.cpixel_bytes(),
            cpixel_high: format.colour_bits() & 0x0000_00FF == 0,
        }
    }

    /// True for the default RGBA-compatible format (copy instead of convert).
    #[inline]
    pub fn is_native(&self) -> bool {
        self.native
    }

    pub fn format(&self) -> PixelFormat {
        self.format
    }

    #[inline]
    pub fn bytes_per_pixel(&self) -> usize {
        self.bytes_per_pixel
    }

    #[inline]
    pub fn cpixel_bytes(&self) -> usize {
        self.cpixel_bytes
    }

    /// Convert one PIXEL (`bytes_per_pixel` bytes).
    #[inline]
    pub fn pixel(&self, src: &[u8]) -> [u8; 4] {
        match self.format.bits_per_pixel {
            8 => self.lut[usize::from(src[0])],
            16 => {
                let value = if self.format.big_endian {
                    u16::from_be_bytes([src[0], src[1]])
                } else {
                    u16::from_le_bytes([src[0], src[1]])
                };
                self.lut[usize::from(value)]
            }
            _ => {
                if self.native {
                    return [src[0], src[1], src[2], 255];
                }
                let bytes = [src[0], src[1], src[2], src[3]];
                let value = if self.format.big_endian {
                    u32::from_be_bytes(bytes)
                } else {
                    u32::from_le_bytes(bytes)
                };
                self.format.value_to_rgba(value)
            }
        }
    }

    /// Convert one ZRLE CPIXEL (`cpixel_bytes` bytes).
    #[inline]
    pub fn cpixel(&self, src: &[u8]) -> [u8; 4] {
        if self.native {
            return [src[0], src[1], src[2], 255];
        }
        if self.cpixel_bytes != 3 {
            return self.pixel(src);
        }
        // Three bytes in the format's byte order; they carry the low 24 bits
        // unless the colour lives in the high three bytes.
        let value = if self.format.big_endian {
            u32::from_be_bytes([0, src[0], src[1], src[2]])
        } else {
            u32::from_le_bytes([src[0], src[1], src[2], 0])
        };
        let value = if self.cpixel_high { value << 8 } else { value };
        self.format.value_to_rgba(value)
    }

    /// Convert a run of PIXELs into packed RGBA.
    pub fn convert_row(&self, src: &[u8], dst: &mut [u8]) {
        let bpp = self.bytes_per_pixel;
        if self.native {
            dst.copy_from_slice(src);
            for pixel in dst.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            return;
        }
        for (out, pixel) in dst.chunks_exact_mut(4).zip(src.chunks_exact(bpp)) {
            out.copy_from_slice(&self.pixel(pixel));
        }
    }
}

impl Default for PixelConverter {
    fn default() -> Self {
        Self::new(PixelFormat::RGB888)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgb888_is_native_and_uses_three_byte_cpixels() {
        let format = PixelFormat::RGB888;
        assert!(format.is_native_rgba());
        assert_eq!(format.cpixel_bytes(), 3);
        assert!(format.tpixel_is_rgb());
        assert_eq!(format.label(), "depth 24 (32 bpp) little-endian rgb888");
        let converter = PixelConverter::new(format);
        assert_eq!(converter.pixel(&[1, 2, 3, 0]), [1, 2, 3, 255]);
        assert_eq!(converter.cpixel(&[1, 2, 3]), [1, 2, 3, 255]);
    }

    #[test]
    fn reduced_colour_formats_expand_to_full_range() {
        let rgb222 = PixelConverter::new(PixelFormat::RGB222);
        assert_eq!(PixelFormat::RGB222.cpixel_bytes(), 1);
        assert_eq!(rgb222.pixel(&[0b11_00_01]), [255, 0, 85, 255]);
        let rgb111 = PixelConverter::new(PixelFormat::RGB111);
        assert_eq!(rgb111.pixel(&[0b101]), [255, 0, 255, 255]);
        assert_eq!(
            PixelFormat::RGB111.label(),
            "depth 3 (8 bpp) little-endian rgb111"
        );
        let rgb565 = PixelConverter::new(PixelFormat::RGB565);
        let value: u16 = (31 << 11) | (63 << 5);
        assert_eq!(rgb565.pixel(&value.to_le_bytes()), [255, 255, 0, 255]);
        assert!(!PixelFormat::RGB565.tpixel_is_rgb());
    }

    #[test]
    fn big_endian_32bpp_cpixel_reads_the_colour_bytes() {
        let format = PixelFormat {
            big_endian: true,
            red_shift: 16,
            green_shift: 8,
            blue_shift: 0,
            ..PixelFormat::RGB888
        };
        let converter = PixelConverter::new(format);
        assert_eq!(converter.pixel(&[0, 10, 20, 30]), [10, 20, 30, 255]);
        assert_eq!(converter.cpixel(&[10, 20, 30]), [10, 20, 30, 255]);
        let mut dst = [0u8; 8];
        converter.convert_row(&[0, 1, 2, 3, 0, 4, 5, 6], &mut dst);
        assert_eq!(dst, [1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn wire_form_matches_set_pixel_format_layout() {
        let wire = PixelFormat::RGB888.to_wire();
        assert_eq!(&wire[..4], &[32, 24, 0, 1]);
        assert_eq!(&wire[4..10], &[0, 255, 0, 255, 0, 255]);
        assert_eq!(&wire[10..13], &[0, 8, 16]);
    }
}
