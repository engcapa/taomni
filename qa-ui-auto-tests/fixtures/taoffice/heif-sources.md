# TaOffice HEIF fixtures

`heif-quadrants.heic` is a generated 160 × 96 image. Its four quadrants contain RGB colors `(220, 42, 42)`, `(36, 183, 61)`, `(39, 83, 207)` and `(224, 174, 28)` in reading order. `heif-enc` from libheif 1.17.6 encoded it with x265 at quality 92. The HEIC contains a primary 8-bit 4:2:0 image. Its SHA-256 is `6c58478e11cfd529b2afdb511ae07ee58859bb03547d4e848d1034fac7ffd0b5`.

`heif-grid-422-10bit.heic` is the synthetic `grid-422-10bit.heic` from heic-rs 0.1.5 under MIT or Apache-2.0. It contains six 64 × 64 tiles at 10-bit 4:2:2. The Rust test compares four pixel samples from its 192 × 128 PNG with Apple's independent `sips` reference. The encoded fixture's SHA-256 is `b5b89e4439c238aa959a066ad5bbd6c8d858bc0ace3b14f2f00b97884202dd54`. [Fixture and license](https://github.com/tbraun96/heic-rs/tree/621014b8e60bb3527670e0b15445926e799340b8/tests/fixtures)
