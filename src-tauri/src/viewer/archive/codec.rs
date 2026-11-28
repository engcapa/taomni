use rars::ReadCancellation;
use std::io::{self, Read, Seek, SeekFrom};

#[derive(Clone, Copy)]
pub(super) enum Codec {
    Plain,
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

impl Codec {
    pub(super) fn reader<'a>(self, input: impl Read + 'a) -> io::Result<Box<dyn Read + 'a>> {
        Ok(match self {
            Self::Plain => Box::new(input),
            Self::Gzip => Box::new(flate2::read::MultiGzDecoder::new(input)),
            Self::Bzip2 => Box::new(bzip2::read::MultiBzDecoder::new(input)),
            Self::Xz => {
                let decoder =
                    xz2::stream::Stream::new_stream_decoder(64 << 20, xz2::stream::CONCATENATED)
                        .map_err(io::Error::other)?;
                Box::new(xz2::read::XzDecoder::new_stream(input, decoder))
            }
            Self::Zstd => {
                let mut decoder = zstd::stream::read::Decoder::new(input)?;
                decoder.window_log_max(25)?;
                Box::new(decoder)
            }
        })
    }
}

/// The bytes of a selected member are checked even when the container has no CRC.
pub(super) struct CheckedReader<R> {
    inner: R,
    pub(super) size: u64,
    pub(super) crc: crc32fast::Hasher,
}

impl<R> CheckedReader<R> {
    pub(super) fn new(inner: R) -> Self {
        Self {
            inner,
            size: 0,
            crc: crc32fast::Hasher::new(),
        }
    }
}

impl<R: Read> Read for CheckedReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(bytes)?;
        self.size += count as u64;
        self.crc.update(&bytes[..count]);
        Ok(count)
    }
}

pub(super) struct Cancellable<R> {
    inner: R,
    cancel: ReadCancellation,
}

impl<R> Cancellable<R> {
    pub(super) fn new(inner: R, cancel: &ReadCancellation) -> Self {
        Self {
            inner,
            cancel: cancel.clone(),
        }
    }

    fn check(&self) -> io::Result<()> {
        if self.cancel.is_cancelled() {
            return Err(io::Error::other("Extraction cancelled"));
        }
        Ok(())
    }
}

impl<R: Read> Read for Cancellable<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.check()?;
        self.inner.read(bytes)
    }
}

impl<R: Seek> Seek for Cancellable<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.check()?;
        self.inner.seek(position)
    }
}
